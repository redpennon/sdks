package redpennon

import (
	"encoding/json"
	"testing"
)

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

func TestNewClient_trimsTrailingSlash(t *testing.T) {
	t.Parallel()
	c := newClient("https://example.test//", "k")
	if c.BaseURL() != "https://example.test" {
		t.Fatalf("expected trailing slashes trimmed, got %q", c.BaseURL())
	}
}

func TestAPIError_FormatsStatusAndMessage(t *testing.T) {
	t.Parallel()
	err := &APIError{StatusCode: 401, Message: "Invalid or missing API key."}
	if err.Error() == "" {
		t.Fatal("Error() should be non-empty")
	}
}

func TestUserContext_omitsUnsetOptionalFields(t *testing.T) {
	t.Parallel()
	payload, err := json.Marshal(UserContext{ID: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"email", "organisation_id", "ip", "audiences", "app_version", "platform", "country", "customData"} {
		if _, ok := got[key]; ok {
			t.Errorf("expected %q to be omitted, got %v", key, got[key])
		}
	}
}

func TestUserContext_serialisesBuiltinsAndCustomData(t *testing.T) {
	t.Parallel()
	payload, err := json.Marshal(UserContext{
		ID:         "u1",
		AppVersion: "4.12.0",
		Platform:   "ios",
		Country:    "AU",
		CustomData: map[string]any{"plan": "enterprise"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatal(err)
	}
	if got["app_version"] != "4.12.0" || got["platform"] != "ios" || got["country"] != "AU" {
		t.Fatalf("unexpected: %v", got)
	}
	custom, _ := got["customData"].(map[string]any)
	if custom["plan"] != "enterprise" {
		t.Fatalf("customData: %v", custom)
	}
}
