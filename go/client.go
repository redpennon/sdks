// Package redpennon is the Go SDK for the RedPennon flag platform.
package redpennon

import (
	"fmt"
	"net/http"
	"strings"
)

// DefaultAPIBaseURL is the production API origin (no trailing slash).
const DefaultAPIBaseURL = "https://api.redpennon.dev"

// UserContext is the targeting context the SDK forwards to the server.
//
// AppVersion, Platform, and Country are built-ins that most flag
// platforms auto-populate from a client-side SDK runtime. Server-side
// SDKs can't reliably detect any of them, so populate them manually
// from your request context (e.g. parsed from a User-Agent header or
// a CDN-supplied geo header) if you want to target on them.
//
// CustomData carries arbitrary attributes for targeting conditions of
// type ``custom_property``; keys are looked up by the rule's
// ``custom_key``, values may be strings, numbers, booleans, or
// []string.
type UserContext struct {
	ID             string         `json:"id,omitempty"`
	Email          string         `json:"email,omitempty"`
	OrganisationID string         `json:"organisation_id,omitempty"`
	IP             string         `json:"ip,omitempty"`
	Audiences      []string       `json:"audiences,omitempty"`
	AppVersion     string         `json:"app_version,omitempty"`
	Platform       string         `json:"platform,omitempty"`
	Country        string         `json:"country,omitempty"`
	CustomData     map[string]any `json:"customData,omitempty"`
}

// APIError is returned for non-2xx responses that include JSON {"error":"..."}.
type APIError struct {
	StatusCode int
	Message    string
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

// BaseURL returns the configured API origin.
func (c *Client) BaseURL() string { return c.baseURL }

// APIKey returns the configured X-Api-Key value.
func (c *Client) APIKey() string { return c.apiKey }
