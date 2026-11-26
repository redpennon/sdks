"""Replays the shared wire-format cases (sdks/contract/cases.json)."""
import json
import pathlib

import httpx
import pytest

from redpennon import APIError, Client, EventPayload, UserContext

CASES = json.loads(
    (pathlib.Path(__file__).resolve().parents[2] / "contract" / "cases.json").read_text()
)


def _client(case):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.raw_path.decode()
        seen["body"] = json.loads(request.content)
        seen["api_key"] = request.headers["X-API-Key"]
        body = case["response"]["body"]
        if isinstance(body, str):
            return httpx.Response(case["response"]["status"], content=body.encode())
        return httpx.Response(case["response"]["status"], json=body)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    return Client(api_key="test-key", base_url="http://api.test", client=http), seen


def _user(raw):
    return None if raw is None else UserContext(**raw)


def _event(raw):
    fields = dict(raw)
    fields["user"] = _user(fields.get("user"))
    return EventPayload(**fields)


@pytest.mark.parametrize("case", CASES["track_events"], ids=lambda c: c["name"])
def test_track_events(case):
    client, seen = _client(case)
    expect = case["expect"]
    events = [_event(e) for e in case["events"]]
    if "error" in expect:
        with pytest.raises(APIError) as exc:
            client.track_events(events)
        assert exc.value.status_code == expect["error"]["status"]
        assert exc.value.code == expect["error"]["code"]
    else:
        result = client.track_events(events)
        assert result.accepted == expect["result"]["accepted"]
        assert result.duplicates == expect["result"]["duplicates"]
        assert seen["body"] == expect["request_body"]
    assert seen["path"] == expect["path"]
    assert seen["api_key"] == "test-key"


@pytest.mark.parametrize("case", CASES["variable"], ids=lambda c: c["name"])
def test_variable(case):
    client, seen = _client(case)
    expect = case["expect"]
    user = _user(case.get("user"))
    if "error" in expect:
        with pytest.raises(APIError) as exc:
            client.variable(case["key"], user=user)
        assert exc.value.status_code == expect["error"]["status"]
        assert exc.value.code == expect["error"]["code"]
    else:
        result = client.variable(case["key"], user=user)
        for field, want in expect["result"].items():
            assert getattr(result, field) == want, field
        assert seen["body"] == expect["request_body"]
    assert seen["path"] == expect["path"]


@pytest.mark.parametrize("case", CASES["variable_value_fail_open"], ids=lambda c: c["name"])
def test_variable_value_fails_open(case):
    client, _ = _client(case)
    assert client.variable_value(case["key"], default=case["default"]) == case["expect"]["value"]
