package redpennon

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClient_Evaluate_success(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/evaluate" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("X-Api-Key") != "test-key" {
			t.Errorf("missing api key header")
		}
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		if payload["feature"] != "my-flag" {
			t.Fatalf("feature: %v", payload["feature"])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"feature":"my-flag","variation":"on","variables":{"show_banner":true},"reason":"targeting_rule_matched"}`))
	}))
	t.Cleanup(srv.Close)

	c := newClient(srv.URL, "test-key")
	res, err := c.Evaluate(context.Background(), EvaluateRequest{Feature: "my-flag"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Feature != "my-flag" || res.Variation == nil || *res.Variation != "on" || res.Reason != "targeting_rule_matched" {
		t.Fatalf("response: %+v", res)
	}
	if v, ok := res.Variables["show_banner"].(bool); !ok || !v {
		t.Fatalf("variables: %#v", res.Variables)
	}
}

func TestClient_Evaluate_nullVariationForTargetingDisabled(t *testing.T) {
	// When targeting is toggled off the API returns ``"variation":
	// null`` and an empty ``variables`` map so the SDK consumer falls
	// back to the code default. Variation must decode to a nil pointer
	// (not the literal string "null" or the empty string).
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"feature":"my-flag","variation":null,"variables":{},"reason":"targeting_disabled"}`))
	}))
	t.Cleanup(srv.Close)

	c := newClient(srv.URL, "test-key")
	res, err := c.Evaluate(context.Background(), EvaluateRequest{Feature: "my-flag"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Variation != nil {
		t.Fatalf("expected nil variation, got %v", *res.Variation)
	}
	if len(res.Variables) != 0 {
		t.Fatalf("expected empty variables, got %#v", res.Variables)
	}
	if res.Reason != "targeting_disabled" {
		t.Fatalf("unexpected reason: %s", res.Reason)
	}
}

func TestClient_EvaluateBatch_success(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/evaluate/batch" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":{"a":{"feature":"a","variation":"off","variables":{},"reason":"feature_not_found"}}}`))
	}))
	t.Cleanup(srv.Close)

	c := newClient(srv.URL, "test-key")
	res, err := c.EvaluateBatch(context.Background(), BatchRequest{Features: []string{"a"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Results["a"].Reason != "feature_not_found" {
		t.Fatalf("result: %+v", res.Results["a"])
	}
}

func TestClient_Evaluate_apiError(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"Invalid or missing API key."}`))
	}))
	t.Cleanup(srv.Close)

	c := newClient(srv.URL, "bad")
	_, err := c.Evaluate(context.Background(), EvaluateRequest{Feature: "x"})
	if err == nil {
		t.Fatal("expected error")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 401 || apiErr.Message != "Invalid or missing API key." {
		t.Fatalf("unexpected: %+v", apiErr)
	}
	if apiErr.Error() == "" {
		t.Fatal("Error() should be non-empty")
	}
}

func TestClient_Evaluate_apiError_nonJSONBody(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream"))
	}))
	t.Cleanup(srv.Close)

	c := newClient(srv.URL, "k")
	_, err := c.Evaluate(context.Background(), EvaluateRequest{Feature: "x"})
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %v", err)
	}
	if apiErr.StatusCode != 500 || apiErr.Message != "upstream" {
		t.Fatalf("unexpected: %+v", apiErr)
	}
}

func TestClient_Evaluate_decodeFailure(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("not json"))
	}))
	t.Cleanup(srv.Close)

	c := newClient(srv.URL, "k")
	_, err := c.Evaluate(context.Background(), EvaluateRequest{Feature: "x"})
	if err == nil {
		t.Fatal("expected decode error")
	}
}

func TestNewClient_usesDefaultBaseURL(t *testing.T) {
	t.Parallel()
	c := NewClient("k")
	if c.baseURL != DefaultAPIBaseURL {
		t.Fatalf("baseURL: got %q want %q", c.baseURL, DefaultAPIBaseURL)
	}
	if c.apiKey != "k" {
		t.Fatalf("apiKey: got %q", c.apiKey)
	}
}

func TestNewClient_trimsTrailingSlash(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/evaluate" {
			t.Errorf("path %q has duplicated slashes", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"feature":"x","variation":"off","variables":{},"reason":"feature_not_found"}`))
	}))
	t.Cleanup(srv.Close)

	c := newClient(srv.URL+"//", "k")
	if _, err := c.Evaluate(context.Background(), EvaluateRequest{Feature: "x"}); err != nil {
		t.Fatal(err)
	}
}

func TestClient_Evaluate_networkError(t *testing.T) {
	t.Parallel()
	c := newClient("http://127.0.0.1:1", "k")
	_, err := c.Evaluate(context.Background(), EvaluateRequest{Feature: "x"})
	if err == nil {
		t.Fatal("expected network error")
	}
}
