"""Tests for the RedPennon Python client.

We drive the client through an ``httpx.MockTransport`` so every test
asserts on the exact HTTP request the SDK sends (URL, headers, body)
and on the exact response the SDK surfaces. This is the only way to
pin the SDK ↔ API contract without spinning up the full Django service
under test.
"""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from redpennon import APIError, Client, DEFAULT_API_BASE_URL, UserContext
from redpennon.client import VariableResult


def _mock_transport(handler):
    """Wrap a request handler in an ``httpx.MockTransport`` that
    captures every outbound request and a list the test can assert on."""
    captured: list[httpx.Request] = []

    def _wrapped(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    return httpx.MockTransport(_wrapped), captured


def _client_with(handler) -> tuple[Client, list[httpx.Request]]:
    transport, captured = _mock_transport(handler)
    http = httpx.Client(transport=transport)
    return Client(api_key="env-key", client=http), captured


# ----------------------------------------------------------------------
# Construction + plumbing
#
# Construction (api key, injected httpx.Client, default base URL) is
# exercised transitively by every per-method test below via
# ``_client_with``; redundant smoke tests were removed to keep this file
# focused on contract behaviour.

def test_api_error_exposes_status_code_and_message() -> None:
    err = APIError(401, "Invalid or missing API key.")
    assert err.status_code == 401
    assert err.message == "Invalid or missing API key."
    assert err.code is None
    assert "401" in str(err)


def test_api_error_parses_governance_code_from_response_body() -> None:
    """Governance error responses carry ``{"error", "code"}``; callers
    branch on ``code`` (``rate_limit_exceeded``, ``organisation_suspended``
    …) rather than parsing ``message``. The code propagates through
    ``Client._post`` whenever the body is structured JSON."""
    import httpx

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            json={"error": "Rate limit exceeded.", "code": "rate_limit_exceeded"},
        )

    client, _ = _client_with(handler)
    with client, pytest.raises(APIError) as exc:
        client.variable("any-key")

    assert exc.value.status_code == 429
    assert exc.value.code == "rate_limit_exceeded"


def test_user_context_omits_unset_optional_fields() -> None:
    assert UserContext(id="u1").to_payload() == {"id": "u1"}


def test_user_context_serialises_builtins_and_custom_data() -> None:
    payload = UserContext(
        id="u1",
        email="a@b.com",
        organisation_id="o1",
        ip="1.2.3.4",
        audiences=["beta"],
        app_version="4.12.0",
        platform="ios",
        country="AU",
        custom_data={"plan": "enterprise", "trial_days": 7},
    ).to_payload()
    assert payload == {
        "id": "u1",
        "email": "a@b.com",
        "organisation_id": "o1",
        "ip": "1.2.3.4",
        "audiences": ["beta"],
        "app_version": "4.12.0",
        "platform": "ios",
        "country": "AU",
        "customData": {"plan": "enterprise", "trial_days": 7},
    }


# ----------------------------------------------------------------------
# ``variable()`` — single-key, full result

class TestVariable:
    def test_returns_full_result_shape(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={
                "key": "show-banner",
                "value": True,
                "variation": "on",
                "reason": "targeting_rule_matched",
                "feature": "marketing",
            })

        client, captured = _client_with(handler)
        with client:
            result = client.variable("show-banner", user=UserContext(id="u"))

        assert isinstance(result, VariableResult)
        assert result.key == "show-banner"
        assert result.value is True
        assert result.variation == "on"
        assert result.reason == "targeting_rule_matched"
        assert result.feature == "marketing"

        assert len(captured) == 1
        req = captured[0]
        assert str(req.url) == f"{DEFAULT_API_BASE_URL}/v1/variables/show-banner"
        assert req.method == "POST"
        assert req.headers["X-API-Key"] == "env-key"
        assert req.headers["Content-Type"] == "application/json"
        assert json.loads(req.content) == {"user": {"id": "u"}}

    def test_url_encodes_the_key(self) -> None:
        captured_urls: list[str] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured_urls.append(str(req.url))
            return httpx.Response(200, json={
                "key": "weird/key", "value": None, "variation": None,
                "reason": "variable_not_found", "feature": None,
            })

        client, _ = _client_with(handler)
        with client:
            client.variable("weird/key")

        assert captured_urls[0].endswith("/v1/variables/weird%2Fkey")

    def test_omits_user_when_no_context_supplied(self) -> None:
        captured_bodies: list[bytes] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured_bodies.append(req.content)
            return httpx.Response(200, json={
                "key": "k", "value": False, "variation": "off",
                "reason": "default_variation", "feature": "f",
            })

        client, _ = _client_with(handler)
        with client:
            client.variable("k")

        assert json.loads(captured_bodies[0]) == {}

    def test_non_2xx_raises_api_error(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": "Invalid or missing API key."})

        client, _ = _client_with(handler)
        with client, pytest.raises(APIError) as exc:
            client.variable("k")

        assert exc.value.status_code == 401

    def test_populates_evaluation_trace_when_present(self) -> None:
        trace = {"matched_rule": "rule-1", "environment": "production"}

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={
                "key": "show-banner",
                "value": True,
                "variation": "on",
                "reason": "targeting_rule_matched",
                "feature": "marketing",
                "evaluation_trace": trace,
            })

        client, _ = _client_with(handler)
        with client:
            result = client.variable("show-banner")

        assert result.evaluation_trace == trace

    def test_evaluation_trace_is_none_when_absent(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={
                "key": "k", "value": False, "variation": "off",
                "reason": "default_variation", "feature": "f",
            })

        client, _ = _client_with(handler)
        with client:
            result = client.variable("k")

        assert result.evaluation_trace is None


# ----------------------------------------------------------------------
# ``variable_value()`` — fail-open fallback to caller's default

class TestVariableValue:
    def test_returns_server_value(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={
                "key": "discount-pct", "value": 25, "variation": "on",
                "reason": "targeting_rule_matched", "feature": "promo",
            })

        client, _ = _client_with(handler)
        with client:
            value = client.variable_value("discount-pct", default=0, user=UserContext(id="u"))
        assert value == 25

    def test_falls_back_when_value_is_null(self) -> None:
        """``variable_not_found``, deleted/archived features, and
        targeting-disabled all surface as ``value=None``; the SDK
        substitutes the caller's default."""
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={
                "key": "discount-pct", "value": None, "variation": None,
                "reason": "variable_not_found", "feature": None,
            })

        client, _ = _client_with(handler)
        with client:
            value = client.variable_value("discount-pct", default=10)
        assert value == 10

    def test_swallows_network_errors_and_returns_default(self) -> None:
        """An unreachable API must not crash the caller. The
        result-shape ``variable()`` method still raises — callers that
        want errors can opt in to it."""
        def handler(req: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("offline")

        client, _ = _client_with(handler)
        with client:
            value = client.variable_value("flag", default="fallback")
        assert value == "fallback"

    def test_swallows_api_errors_and_returns_default(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": "nope"})

        client, _ = _client_with(handler)
        with client:
            value = client.variable_value("flag", default=False)
        assert value is False


# ----------------------------------------------------------------------
# ``variables()`` — batch

class TestVariablesBatch:
    def test_returns_result_per_key(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={
                "results": {
                    "a": {
                        "key": "a", "value": True, "variation": "on",
                        "reason": "default_variation", "feature": "f-a",
                    },
                    "b": {
                        "key": "b", "value": None, "variation": None,
                        "reason": "variable_not_found", "feature": None,
                    },
                },
            })

        client, captured = _client_with(handler)
        with client:
            results = client.variables(["a", "b"], user=UserContext(id="u"))

        assert results["a"].value is True
        assert results["b"].reason == "variable_not_found"
        assert str(captured[0].url) == f"{DEFAULT_API_BASE_URL}/v1/variables"
        assert json.loads(captured[0].content) == {
            "keys": ["a", "b"],
            "user": {"id": "u"},
        }

    def test_omits_user_when_no_context_supplied(self) -> None:
        captured_bodies: list[bytes] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured_bodies.append(req.content)
            return httpx.Response(200, json={"results": {}})

        client, _ = _client_with(handler)
        with client:
            client.variables([])

        assert json.loads(captured_bodies[0]) == {"keys": []}

    def test_non_2xx_raises_api_error(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": "nope"})

        client, _ = _client_with(handler)
        with client, pytest.raises(APIError) as exc:
            client.variables(["x"])

        assert exc.value.status_code == 401
