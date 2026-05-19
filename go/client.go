// Package redpennon is the Go SDK for the RedPennon flag platform.
//
// The SDK exposes two evaluation entry points so callers can pick the
// ergonomics that fit their code:
//
//   - [Client.Variable] returns the full [VariableResult] (value,
//     variation, reason, feature) plus an error. Use this when you
//     need to branch on reason or report telemetry.
//
//   - [Client.VariableValue] returns just the served value or the
//     caller-supplied default on any failure. Use this when you want
//     "give me the flag value, or this fallback if anything goes
//     wrong" semantics. The error return is informational — the
//     value return is the contract: it is always safe to use, even
//     when err != nil.
//
// Batch evaluation via [Client.Variables] resolves many flags in one
// HTTP round-trip.
package redpennon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// DefaultAPIBaseURL is the production API origin (no trailing slash).
const DefaultAPIBaseURL = "https://api.redpennon.dev"

// EvaluationReason enumerates the reason strings the server returns
// in the result. Mirrors the server enum 1:1 so callers can switch
// on the string.
type EvaluationReason string

const (
	ReasonTargetingRuleMatched   EvaluationReason = "targeting_rule_matched"
	ReasonDefaultVariation       EvaluationReason = "default_variation"
	ReasonNoRuleMatched          EvaluationReason = "no_rule_matched"
	ReasonTargetingDisabled      EvaluationReason = "targeting_disabled"
	ReasonFeatureComplete        EvaluationReason = "feature_complete"
	ReasonFeatureDeleted         EvaluationReason = "feature_deleted"
	ReasonFeatureArchived        EvaluationReason = "feature_archived"
	ReasonSelfTargetingOverride  EvaluationReason = "self_targeting_override"
	ReasonVariableNotFound       EvaluationReason = "variable_not_found"
)

// UserContext is the targeting context the SDK forwards to the server.
//
// AppVersion, Platform, and Country are built-ins that most flag
// platforms auto-populate from a client-side SDK runtime. Server-side
// SDKs can't reliably detect any of them, so populate them manually
// from your request context (e.g. parsed from a User-Agent header or
// a CDN-supplied geo header) if you want to target on them.
//
// CustomData carries arbitrary attributes for targeting conditions of
// type custom_property; keys are looked up by the rule's
// custom_key, values may be strings, numbers, booleans, or []string.
type UserContext struct {
	ID             string         `json:"id,omitempty"`
	Email          string         `json:"email,omitempty"`
	OrganisationID string         `json:"organisation_id,omitempty"`
	IP             string         `json:"ip,omitempty"`
	Audiences      []string       `json:"audiences,omitempty"`
	AppVersion     string         `json:"app_version,omitempty"`
	Platform       string         `json:"platform,omitempty"`
	Country        string         `json:"country,omitempty"`
	CustomData     map[string]any `json:"custom_data,omitempty"`
}

// VariableResult is the server's evaluation outcome for a single
// variable. Value is nil whenever the platform served no value
// (unknown key, targeting disabled, feature deleted/archived);
// Variation and Feature are likewise nil in those cases.
type VariableResult struct {
	Key             string           `json:"key"`
	Value           any              `json:"value"`
	Variation       *string          `json:"variation"`
	Reason          EvaluationReason `json:"reason"`
	Feature         *string          `json:"feature"`
	EvaluationTrace string           `json:"evaluation_trace,omitempty"`
}

// APIError is returned for non-2xx responses.
//
// Code mirrors the platform's governance error vocabulary
// (rate_limit_exceeded, organisation_suspended,
// monthly_active_users_exceeded …) when the response body carries a
// structured {"error", "code"} payload. Empty for transport errors or
// unstructured responses; callers branching on governance state should
// match on Code, not Message.
type APIError struct {
	StatusCode int
	Message    string
	Code       string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("redpennon: api error %d: %s", e.StatusCode, e.Message)
}

// Client calls the RedPennon API.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

// NewClient returns a client that calls [DefaultAPIBaseURL] with the
// given X-API-Key.
func NewClient(apiKey string) *Client {
	return newClient(DefaultAPIBaseURL, apiKey)
}

// ClientOption configures a Client at construction time.
type ClientOption func(*Client)

// WithBaseURL overrides the API origin (handy for self-hosted
// installs and tests).
func WithBaseURL(baseURL string) ClientOption {
	return func(c *Client) { c.baseURL = strings.TrimRight(baseURL, "/") }
}

// WithHTTPClient injects a custom *http.Client (e.g. one with
// instrumentation, a custom transport, or a constrained timeout).
func WithHTTPClient(h *http.Client) ClientOption {
	return func(c *Client) { c.httpClient = h }
}

// NewClientWithOptions is the option-bearing counterpart to NewClient.
func NewClientWithOptions(apiKey string, opts ...ClientOption) *Client {
	c := newClient(DefaultAPIBaseURL, apiKey)
	for _, opt := range opts {
		opt(c)
	}
	return c
}

func newClient(baseURL, apiKey string) *Client {
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		apiKey:     apiKey,
		httpClient: http.DefaultClient,
	}
}

// BaseURL returns the configured API origin.
func (c *Client) BaseURL() string { return c.baseURL }

// APIKey returns the configured X-API-Key value.
func (c *Client) APIKey() string { return c.apiKey }

// Variable resolves a single variable to its full [VariableResult].
// Returns an [*APIError] on non-2xx responses and the underlying
// transport error on network failures.
func (c *Client) Variable(ctx context.Context, key string, user *UserContext) (*VariableResult, error) {
	body := map[string]any{}
	if user != nil {
		body["user"] = user
	}
	resp, err := c.post(ctx, "/v1/variables/"+url.PathEscape(key), body)
	if err != nil {
		return nil, err
	}
	var result VariableResult
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, fmt.Errorf("redpennon: decode variable response: %w", err)
	}
	return &result, nil
}

// VariableValue resolves a single variable and returns its value, or
// defaultValue on any failure (unreachable API, non-2xx, value=null).
// The value return is always safe to use — even when err != nil the
// caller's default has been substituted in, so a typical caller may
// safely write:
//
//	value, _ := client.VariableValue(ctx, "show-banner", false, user)
func (c *Client) VariableValue(ctx context.Context, key string, defaultValue any, user *UserContext) (any, error) {
	result, err := c.Variable(ctx, key, user)
	if err != nil {
		return defaultValue, err
	}
	if result.Value == nil {
		return defaultValue, nil
	}
	return result.Value, nil
}

// EventPayload describes a single analytics event sent to [Client.TrackEvents].
//
// Event, Variable, and Variation are required. User, Value, OccurredAt, and
// EvaluationTrace are optional; set EvaluationTrace from [VariableResult.EvaluationTrace]
// to correlate an event with the evaluation that produced the served variation.
type EventPayload struct {
	Event           string       `json:"event"`
	Variable        string       `json:"variable"`
	Variation       string       `json:"variation"`
	User            *UserContext `json:"user,omitempty"`
	Value           *float64     `json:"value,omitempty"`
	OccurredAt      string       `json:"occurred_at,omitempty"`
	EvaluationTrace string       `json:"evaluation_trace,omitempty"`
}

// TrackEventsResult is the server's acknowledgement of a [Client.TrackEvents] call.
type TrackEventsResult struct {
	Accepted int `json:"accepted"`
}

// TrackEvents submits a batch of analytics events to the platform.
// Returns a [*APIError] on any non-202 response.
func (c *Client) TrackEvents(ctx context.Context, events []EventPayload) (*TrackEventsResult, error) {
	resp, err := c.post(ctx, "/v1/events", map[string]any{"events": events})
	if err != nil {
		return nil, err
	}
	var result TrackEventsResult
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, fmt.Errorf("redpennon: decode track events response: %w", err)
	}
	return &result, nil
}

// Variables resolves a batch of variable keys in one HTTP round-trip.
// Each key in the response has the same shape as [Client.Variable];
// unknown keys surface as ReasonVariableNotFound inline rather than
// failing the whole batch.
func (c *Client) Variables(ctx context.Context, keys []string, user *UserContext) (map[string]VariableResult, error) {
	body := map[string]any{"keys": keys}
	if user != nil {
		body["user"] = user
	}
	resp, err := c.post(ctx, "/v1/variables", body)
	if err != nil {
		return nil, err
	}
	var wrapper struct {
		Results map[string]VariableResult `json:"results"`
	}
	if err := json.Unmarshal(resp, &wrapper); err != nil {
		return nil, fmt.Errorf("redpennon: decode variables response: %w", err)
	}
	if wrapper.Results == nil {
		wrapper.Results = map[string]VariableResult{}
	}
	return wrapper.Results, nil
}

func (c *Client) post(ctx context.Context, path string, body any) ([]byte, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("redpennon: encode request body: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-API-Key", c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		message, code := errorFieldsFromBody(data, resp.Status)
		return nil, &APIError{
			StatusCode: resp.StatusCode,
			Message:    message,
			Code:       code,
		}
	}
	return data, nil
}

func errorFieldsFromBody(body []byte, fallback string) (string, string) {
	if len(body) == 0 {
		return fallback, ""
	}
	var payload struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(body, &payload); err == nil {
		message := payload.Error
		if message == "" {
			message = fallback
		}
		return message, payload.Code
	}
	return fallback, ""
}
