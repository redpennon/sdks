from __future__ import annotations

import httpx

from redpennon import APIError, Client, DEFAULT_API_BASE_URL, UserContext


def test_client_constructs_with_api_key() -> None:
    with Client(api_key="test-key") as c:
        assert c.api_key == "test-key"


def test_client_accepts_injected_httpx_client() -> None:
    transport = httpx.MockTransport(lambda req: httpx.Response(204))
    with httpx.Client(transport=transport) as http:
        c = Client(api_key="k", client=http)
        assert c.api_key == "k"


def test_default_base_url_is_set() -> None:
    assert DEFAULT_API_BASE_URL == "https://api.redpennon.dev"


def test_api_error_exposes_status_code_and_message() -> None:
    err = APIError(401, "Invalid or missing API key.")
    assert err.status_code == 401
    assert err.message == "Invalid or missing API key."
    assert "401" in str(err)


def test_user_context_omits_unset_optional_fields() -> None:
    payload = UserContext(id="u1").to_payload()
    assert payload == {"id": "u1"}


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
