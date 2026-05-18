package redpennon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// roundTripFunc lets a test inject HTTP behaviour without spinning
// up an httptest.Server — every request flows through the function
// and the test asserts on it before returning a synthetic response.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func newTestClient(rt roundTripFunc) (*Client, *[]*http.Request) {
	captured := &[]*http.Request{}
	c := NewClientWithOptions("env-key",
		WithHTTPClient(&http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			*captured = append(*captured, req)
			return rt(req)
		})}),
	)
	return c, captured
}

func jsonResponse(status int, body any) *http.Response {
	data, _ := json.Marshal(body)
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(string(data))),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
	}
}

// ---------------------------------------------------------------------
// Construction

func TestNewClient_usesDefaultBaseURL(t *testing.T) {
	t.Parallel()
	c := NewClient("k")
	if c.BaseURL() != DefaultAPIBaseURL {
		t.Fatalf("baseURL: got %q want %q", c.BaseURL(), DefaultAPIBaseURL)
	}
	if c.APIKey() != "k" {
		t.Fatalf("apiKey: got %q", c.APIKey())
	}
}

func TestWithBaseURL_trimsTrailingSlash(t *testing.T) {
	t.Parallel()
	c := NewClientWithOptions("k", WithBaseURL("https://example.test//"))
	if c.BaseURL() != "https://example.test" {
		t.Fatalf("expected trailing slashes trimmed, got %q", c.BaseURL())
	}
}

func TestAPIError_FormatsStatusAndMessage(t *testing.T) {
	t.Parallel()
	err := &APIError{StatusCode: 401, Message: "Invalid or missing API key."}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("Error() %q should contain 401", err.Error())
	}
}

// Governance error responses carry {"error", "code"}; callers branch on
// Code (rate_limit_exceeded, organisation_suspended …) rather than the
// human-readable Message. The code is parsed once when the SDK builds
// APIError, so consumers don't need to unmarshal Body themselves.
func TestAPIError_CarriesGovernanceCodeFromResponseBody(t *testing.T) {
	t.Parallel()
	c, _ := newTestClient(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(429, map[string]string{
			"error": "Rate limit exceeded.",
			"code":  "rate_limit_exceeded",
		}), nil
	})

	_, err := c.Variable(context.Background(), "any-key", nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected APIError, got %T %v", err, err)
	}
	if apiErr.StatusCode != 429 {
		t.Fatalf("StatusCode: got %d want 429", apiErr.StatusCode)
	}
	if apiErr.Code != "rate_limit_exceeded" {
		t.Fatalf("Code: got %q want %q", apiErr.Code, "rate_limit_exceeded")
	}
}

// ---------------------------------------------------------------------
// UserContext serialisation

func TestUserContext_omitsUnsetOptionalFields(t *testing.T) {
	t.Parallel()
	payload, _ := json.Marshal(UserContext{ID: "u1"})
	var got map[string]any
	_ = json.Unmarshal(payload, &got)
	for _, key := range []string{"email", "organisation_id", "ip", "audiences", "app_version", "platform", "country", "customData"} {
		if _, ok := got[key]; ok {
			t.Errorf("expected %q to be omitted, got %v", key, got[key])
		}
	}
}

func TestUserContext_serialisesBuiltinsAndCustomData(t *testing.T) {
	t.Parallel()
	payload, _ := json.Marshal(UserContext{
		ID: "u1", AppVersion: "4.12.0", Platform: "ios", Country: "AU",
		CustomData: map[string]any{"plan": "enterprise"},
	})
	var got map[string]any
	_ = json.Unmarshal(payload, &got)
	if got["app_version"] != "4.12.0" || got["platform"] != "ios" || got["country"] != "AU" {
		t.Fatalf("unexpected: %v", got)
	}
	custom, _ := got["customData"].(map[string]any)
	if custom["plan"] != "enterprise" {
		t.Fatalf("customData: %v", custom)
	}
}

// ---------------------------------------------------------------------
// Variable()

func TestVariable_postsToVariableKeyEndpoint(t *testing.T) {
	t.Parallel()
	c, captured := newTestClient(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(200, map[string]any{
			"key": "show-banner", "value": true, "variation": "on",
			"reason": "targeting_rule_matched", "feature": "marketing",
		}), nil
	})

	result, err := c.Variable(context.Background(), "show-banner",
		&UserContext{ID: "user-123", Email: "alice@example.com"})
	if err != nil {
		t.Fatalf("Variable: %v", err)
	}

	if result.Key != "show-banner" || result.Value != true {
		t.Fatalf("unexpected result: %+v", result)
	}
	if *result.Variation != "on" || result.Reason != ReasonTargetingRuleMatched {
		t.Fatalf("unexpected variation/reason: %+v", result)
	}

	if len(*captured) != 1 {
		t.Fatalf("expected 1 request, got %d", len(*captured))
	}
	req := (*captured)[0]
	if req.Method != http.MethodPost {
		t.Fatalf("method: %s", req.Method)
	}
	if !strings.HasSuffix(req.URL.Path, "/v1/variables/show-banner") {
		t.Fatalf("path: %s", req.URL.Path)
	}
	if req.Header.Get("X-API-Key") != "env-key" {
		t.Fatalf("X-API-Key not set")
	}
}

func TestVariable_urlEncodesKey(t *testing.T) {
	t.Parallel()
	c, captured := newTestClient(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(200, map[string]any{
			"key": "weird/key", "value": nil, "variation": nil,
			"reason": "variable_not_found", "feature": nil,
		}), nil
	})

	_, err := c.Variable(context.Background(), "weird/key", nil)
	if err != nil {
		t.Fatalf("Variable: %v", err)
	}
	// EscapedPath leaves the encoded "%2F" intact.
	want := "/v1/variables/" + url.PathEscape("weird/key")
	if (*captured)[0].URL.EscapedPath() != want {
		t.Fatalf("expected encoded path %q, got %q", want, (*captured)[0].URL.EscapedPath())
	}
}

func TestVariable_returnsAPIErrorOn401(t *testing.T) {
	t.Parallel()
	c, _ := newTestClient(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(401, map[string]any{"error": "Invalid or missing API key."}), nil
	})
	_, err := c.Variable(context.Background(), "k", nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected APIError, got %T %v", err, err)
	}
	if apiErr.StatusCode != 401 {
		t.Fatalf("status: %d", apiErr.StatusCode)
	}
}

// ---------------------------------------------------------------------
// VariableValue()

func TestVariableValue_returnsServerValue(t *testing.T) {
	t.Parallel()
	c, _ := newTestClient(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(200, map[string]any{
			"key": "k", "value": 25.0, "variation": "on",
			"reason": "targeting_rule_matched", "feature": "f",
		}), nil
	})
	value, err := c.VariableValue(context.Background(), "k", 0, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if value != 25.0 {
		t.Fatalf("value: %v", value)
	}
}

func TestVariableValue_fallsBackOnNullValue(t *testing.T) {
	t.Parallel()
	c, _ := newTestClient(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(200, map[string]any{
			"key": "k", "value": nil, "variation": nil,
			"reason": "variable_not_found", "feature": nil,
		}), nil
	})
	value, err := c.VariableValue(context.Background(), "k", "fallback", nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if value != "fallback" {
		t.Fatalf("value: %v", value)
	}
}

func TestVariableValue_returnsDefaultAndErrorOnTransportFailure(t *testing.T) {
	t.Parallel()
	wantErr := errors.New("offline")
	c, _ := newTestClient(func(req *http.Request) (*http.Response, error) {
		return nil, wantErr
	})
	value, err := c.VariableValue(context.Background(), "k", "fallback", nil)
	if err == nil {
		t.Fatal("expected error")
	}
	// The value return is the caller-supplied default — load-bearing
	// even when err != nil so the caller can safely ignore the error.
	if value != "fallback" {
		t.Fatalf("value: %v", value)
	}
}

// ---------------------------------------------------------------------
// Variables() (batch)

func TestVariables_returnsResultPerKey(t *testing.T) {
	t.Parallel()
	c, captured := newTestClient(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(200, map[string]any{
			"results": map[string]any{
				"a": map[string]any{
					"key": "a", "value": true, "variation": "on",
					"reason": "default_variation", "feature": "f-a",
				},
				"b": map[string]any{
					"key": "b", "value": nil, "variation": nil,
					"reason": "variable_not_found", "feature": nil,
				},
			},
		}), nil
	})
	results, err := c.Variables(context.Background(), []string{"a", "b"}, &UserContext{ID: "u"})
	if err != nil {
		t.Fatalf("Variables: %v", err)
	}
	if results["a"].Value != true {
		t.Fatalf("results[a].Value: %v", results["a"].Value)
	}
	if results["b"].Reason != ReasonVariableNotFound {
		t.Fatalf("results[b].Reason: %v", results["b"].Reason)
	}
	if !strings.HasSuffix((*captured)[0].URL.Path, "/v1/variables") {
		t.Fatalf("path: %s", (*captured)[0].URL.Path)
	}
}

func TestVariables_returnsAPIErrorOn401(t *testing.T) {
	t.Parallel()
	c, _ := newTestClient(func(req *http.Request) (*http.Response, error) {
		return jsonResponse(401, map[string]any{"error": "nope"}), nil
	})
	_, err := c.Variables(context.Background(), []string{"a"}, nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected APIError, got %T", err)
	}
}
