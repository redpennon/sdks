from __future__ import annotations

import json

import httpx
import pytest

from redpennon import APIError, DEFAULT_API_BASE_URL, Client, UserContext


def _request_json(request: httpx.Request) -> dict:
    return json.loads(request.content.decode("utf-8"))


def test_evaluate_success() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert str(request.url).startswith(DEFAULT_API_BASE_URL)
        assert request.url.path == "/v1/evaluate"
        assert request.headers.get("x-api-key") == "test-key"
        assert _request_json(request) == {"feature": "my-flag"}
        return httpx.Response(
            200,
            json={
                "feature": "my-flag",
                "variation": "on",
                "variables": {"show_banner": True},
                "reason": "targeting_rule_matched",
            },
        )

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http:
        c = Client(api_key="test-key", client=http)
        res = c.evaluate(feature="my-flag")
    assert res.feature == "my-flag"
    assert res.variation == "on"
    assert res.reason == "targeting_rule_matched"
    assert res.variables["show_banner"] is True


def test_evaluate_targeting_disabled_yields_null_variation() -> None:
    """When targeting is toggled off the API returns ``"variation":
    null`` so the caller falls back to whatever default they hard-coded
    for the variable. The SDK must surface that as
    ``EvaluateResponse.variation is None`` rather than coercing it to
    the string "None"."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "feature": "my-flag",
                "variation": None,
                "variables": {},
                "reason": "targeting_disabled",
            },
        )

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http:
        c = Client(api_key="k", client=http)
        res = c.evaluate(feature="my-flag")
    assert res.variation is None
    assert dict(res.variables) == {}
    assert res.reason == "targeting_disabled"


def test_user_context_serialises_new_builtin_and_custom_fields() -> None:
    """``app_version``, ``platform``, ``country``, and ``custom_data``
    map to their wire-side counterparts (``customData`` rather than
    ``custom_data``) and only serialise when explicitly set."""

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["json"] = _request_json(request)
        return httpx.Response(
            200,
            json={
                "feature": "f",
                "variation": "on",
                "variables": {},
                "reason": "targeting_rule_matched",
            },
        )

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http:
        c = Client(api_key="k", client=http)
        u = UserContext(
            id="u1",
            app_version="4.12.0",
            platform="ios",
            country="AU",
            custom_data={"plan": "enterprise", "trial_days": 7},
        )
        c.evaluate(feature="f", user=u)
    payload = captured["json"]
    assert payload["user"]["app_version"] == "4.12.0"
    assert payload["user"]["platform"] == "ios"
    assert payload["user"]["country"] == "AU"
    assert payload["user"]["customData"] == {
        "plan": "enterprise", "trial_days": 7,
    }


def test_user_context_omits_unset_optional_fields() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["json"] = _request_json(request)
        return httpx.Response(
            200,
            json={"feature": "f", "variation": "on", "variables": {}, "reason": "x"},
        )

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http:
        c = Client(api_key="k", client=http)
        c.evaluate(feature="f", user=UserContext(id="u1"))
    user = captured["json"]["user"]
    assert "app_version" not in user
    assert "platform" not in user
    assert "country" not in user
    assert "customData" not in user


def test_evaluate_with_user_context() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["json"] = _request_json(request)
        return httpx.Response(
            200,
            json={
                "feature": "f",
                "variation": "off",
                "variables": {},
                "reason": "default_variation",
            },
        )

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http:
        c = Client(api_key="k", client=http)
        u = UserContext(
            id="u1",
            email="a@b.com",
            organisation_id="o1",
            ip="1.2.3.4",
            audiences=["beta"],
        )
        c.evaluate(feature="f", user=u)
    assert captured["json"]["user"]["id"] == "u1"
    assert captured["json"]["user"]["audiences"] == ["beta"]


def test_evaluate_batch_success() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/evaluate/batch"
        return httpx.Response(
            200,
            json={
                "results": {
                    "a": {
                        "feature": "a",
                        "variation": "off",
                        "variables": {},
                        "reason": "feature_not_found",
                    }
                }
            },
        )

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http:
        c = Client(api_key="k", client=http)
        batch = c.evaluate_batch(features=["a"])
    assert batch.results["a"].reason == "feature_not_found"


def test_evaluate_batch_with_user() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert _request_json(request)["user"]["id"] == "9"
        return httpx.Response(
            200,
            json={
                "results": {
                    "a": {
                        "feature": "a",
                        "variation": "off",
                        "variables": {},
                        "reason": "feature_not_found",
                    }
                }
            },
        )

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http:
        c = Client(api_key="k", client=http)
        batch = c.evaluate_batch(features=["a"], user={"id": "9"})
    assert batch.results["a"].reason == "feature_not_found"


def test_api_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "Invalid or missing API key."})

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http:
        c = Client(api_key="bad", client=http)
        with pytest.raises(APIError) as ei:
            c.evaluate(feature="x")
    assert ei.value.status_code == 401


def test_evaluate_with_user_dict_and_empty_user_context_omitted() -> None:
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(_request_json(request))
        return httpx.Response(
            200,
            json={
                "feature": "f",
                "variation": "off",
                "variables": {},
                "reason": "default_variation",
            },
        )

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http:
        c = Client(api_key="k", client=http)
        c.evaluate(feature="f", user={"id": "1"})
        c.evaluate(feature="f", user=UserContext())
    assert bodies[0] == {"feature": "f", "user": {"id": "1"}}
    assert bodies[1] == {"feature": "f"}


def test_api_error_non_json_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b"upstream")

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http:
        c = Client(api_key="k", client=http)
        with pytest.raises(APIError) as ei:
            c.evaluate(feature="x")
    assert ei.value.status_code == 500
    assert "upstream" in ei.value.message
