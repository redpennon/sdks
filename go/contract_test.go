package redpennon

// Replays the shared wire-format cases (sdks/contract/cases.json).

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

type contractResponse struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

type contractError struct {
	Status int     `json:"status"`
	Code   *string `json:"code"`
}

type contractCases struct {
	TrackEvents []struct {
		Name     string           `json:"name"`
		Events   []EventPayload   `json:"events"`
		Response contractResponse `json:"response"`
		Expect   struct {
			Path        string          `json:"path"`
			RequestBody json.RawMessage `json:"request_body"`
			Result      *struct {
				Accepted   int `json:"accepted"`
				Duplicates int `json:"duplicates"`
			} `json:"result"`
			Error *contractError `json:"error"`
		} `json:"expect"`
	} `json:"track_events"`
	Variable []struct {
		Name     string           `json:"name"`
		Key      string           `json:"key"`
		User     *UserContext     `json:"user"`
		Response contractResponse `json:"response"`
		Expect   struct {
			Path        string          `json:"path"`
			RequestBody json.RawMessage `json:"request_body"`
			Result      json.RawMessage `json:"result"`
			Error       *contractError  `json:"error"`
		} `json:"expect"`
	} `json:"variable"`
	FailOpen []struct {
		Name     string           `json:"name"`
		Key      string           `json:"key"`
		Default  string           `json:"default"`
		Response contractResponse `json:"response"`
		Expect   struct {
			Value string `json:"value"`
		} `json:"expect"`
	} `json:"variable_value_fail_open"`
}

func loadContract(t *testing.T) contractCases {
	t.Helper()
	raw, err := os.ReadFile("../contract/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var c contractCases
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// serve answers with the case's canned response and records the request.
func serve(resp contractResponse, path *string, body *any) *Client {
	c, _ := newTestClient(func(req *http.Request) (*http.Response, error) {
		*path = req.URL.EscapedPath()
		raw, _ := io.ReadAll(req.Body)
		_ = json.Unmarshal(raw, body)
		payload := string(resp.Body)
		// A JSON string body is sent as raw text (it models a non-JSON reply).
		var asString string
		if json.Unmarshal(resp.Body, &asString) == nil {
			payload = asString
		}
		return &http.Response{
			StatusCode: resp.Status,
			Body:       io.NopCloser(strings.NewReader(payload)),
			Header:     http.Header{},
		}, nil
	})
	return c
}

func sameJSON(t *testing.T, want json.RawMessage, got any) {
	t.Helper()
	var w any
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatal(err)
	}
	gotRaw, _ := json.Marshal(got)
	var g any
	_ = json.Unmarshal(gotRaw, &g)
	if !reflect.DeepEqual(w, g) {
		t.Fatalf("request body mismatch\n want %s\n  got %s", want, gotRaw)
	}
}

func assertAPIError(t *testing.T, err error, want *contractError) {
	t.Helper()
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("want *APIError, got %v", err)
	}
	if apiErr.StatusCode != want.Status {
		t.Fatalf("status = %d, want %d", apiErr.StatusCode, want.Status)
	}
	wantCode := ""
	if want.Code != nil {
		wantCode = *want.Code
	}
	if apiErr.Code != wantCode {
		t.Fatalf("code = %q, want %q", apiErr.Code, wantCode)
	}
}

func TestContract_TrackEvents(t *testing.T) {
	for _, c := range loadContract(t).TrackEvents {
		t.Run(c.Name, func(t *testing.T) {
			var path string
			var body any
			client := serve(c.Response, &path, &body)
			res, err := client.TrackEvents(context.Background(), c.Events)
			if c.Expect.Error != nil {
				assertAPIError(t, err, c.Expect.Error)
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if res.Accepted != c.Expect.Result.Accepted || res.Duplicates != c.Expect.Result.Duplicates {
					t.Fatalf("result = %+v, want %+v", res, c.Expect.Result)
				}
				sameJSON(t, c.Expect.RequestBody, body)
			}
			if path != c.Expect.Path {
				t.Fatalf("path = %q, want %q", path, c.Expect.Path)
			}
		})
	}
}

func TestContract_Variable(t *testing.T) {
	for _, c := range loadContract(t).Variable {
		t.Run(c.Name, func(t *testing.T) {
			var path string
			var body any
			client := serve(c.Response, &path, &body)
			res, err := client.Variable(context.Background(), c.Key, c.User)
			if c.Expect.Error != nil {
				assertAPIError(t, err, c.Expect.Error)
			} else {
				if err != nil {
					t.Fatal(err)
				}
				var want map[string]any
				_ = json.Unmarshal(c.Expect.Result, &want)
				gotRaw, _ := json.Marshal(res)
				var got map[string]any
				_ = json.Unmarshal(gotRaw, &got)
				for field, v := range want {
					if !reflect.DeepEqual(got[field], v) {
						t.Fatalf("%s = %#v, want %#v", field, got[field], v)
					}
				}
				sameJSON(t, c.Expect.RequestBody, body)
			}
			if path != c.Expect.Path {
				t.Fatalf("path = %q, want %q", path, c.Expect.Path)
			}
		})
	}
}

func TestContract_VariableValueFailsOpen(t *testing.T) {
	for _, c := range loadContract(t).FailOpen {
		t.Run(c.Name, func(t *testing.T) {
			var path string
			var body any
			client := serve(c.Response, &path, &body)
			got, _ := client.VariableValue(context.Background(), c.Key, c.Default, nil)
			if got != c.Expect.Value {
				t.Fatalf("value = %#v, want %q", got, c.Expect.Value)
			}
		})
	}
}
