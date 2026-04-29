package redpennon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// DefaultAPIBaseURL is the production evaluation API origin (no trailing slash).
const DefaultAPIBaseURL = "https://api.redpennon.dev"

// UserContext maps to the evaluation API "user" object.
type UserContext struct {
	ID               string   `json:"id,omitempty"`
	Email            string   `json:"email,omitempty"`
	OrganisationID   string   `json:"organisation_id,omitempty"`
	IP               string   `json:"ip,omitempty"`
	Audiences        []string `json:"audiences,omitempty"`
}

// EvaluateRequest is the body for POST /v1/evaluate/.
type EvaluateRequest struct {
	Feature string       `json:"feature"`
	User    *UserContext `json:"user,omitempty"`
}

// EvaluateResponse is a successful 200 from POST /v1/evaluate/.
type EvaluateResponse struct {
	Feature    string         `json:"feature"`
	Variation  string         `json:"variation"`
	Variables  map[string]any `json:"variables"`
	Reason     string         `json:"reason"`
}

// BatchRequest is the body for POST /v1/evaluate/batch/.
type BatchRequest struct {
	Features []string     `json:"features"`
	User     *UserContext `json:"user,omitempty"`
}

// BatchResponse is a successful 200 from POST /v1/evaluate/batch/.
type BatchResponse struct {
	Results map[string]EvaluateResponse `json:"results"`
}

// APIError is returned for non-2xx responses that include JSON {"error":"..."}.
type APIError struct {
	StatusCode int
	Message    string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("redpennon: api error %d: %s", e.StatusCode, e.Message)
}

// Client calls the RedPennon evaluation API.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

// NewClient returns a client that calls [DefaultAPIBaseURL] with the given X-Api-Key.
func NewClient(apiKey string) *Client {
	return newClient(DefaultAPIBaseURL, apiKey)
}

func newClient(baseURL, apiKey string) *Client {
	b := strings.TrimRight(baseURL, "/")
	return &Client{
		baseURL:    b,
		apiKey:     apiKey,
		httpClient: http.DefaultClient,
	}
}

func (c *Client) postJSON(ctx context.Context, path string, body any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", c.apiKey)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var apiErr struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &apiErr)
		msg := apiErr.Error
		if msg == "" {
			msg = strings.TrimSpace(string(raw))
		}
		return &APIError{StatusCode: resp.StatusCode, Message: msg}
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("redpennon: decode response: %w", err)
	}
	return nil
}

// Evaluate calls POST /v1/evaluate/.
func (c *Client) Evaluate(ctx context.Context, req EvaluateRequest) (*EvaluateResponse, error) {
	var out EvaluateResponse
	if err := c.postJSON(ctx, "/v1/evaluate/", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// EvaluateBatch calls POST /v1/evaluate/batch/.
func (c *Client) EvaluateBatch(ctx context.Context, req BatchRequest) (*BatchResponse, error) {
	var out BatchResponse
	if err := c.postJSON(ctx, "/v1/evaluate/batch/", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
