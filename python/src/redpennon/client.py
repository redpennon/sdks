from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import httpx

DEFAULT_API_BASE_URL = "https://api.redpennon.dev"


@dataclass(frozen=True, slots=True)
class UserContext:
    """Targeting context the SDK forwards to the server.

    ``app_version``, ``platform``, and ``country`` are built-ins that
    most flag platforms auto-populate from a client-side SDK runtime.
    Server-side SDKs can't reliably detect any of them — populate them
    manually from your request context (e.g. parsed from a User-Agent
    header or a CDN-supplied geo header) if you want to target on
    them.

    ``custom_data`` carries arbitrary attributes for targeting
    conditions of type ``custom_property``; keys are looked up by the
    rule's ``custom_key`` and values may be scalars or list-of-strings.
    On the wire it serialises as ``customData`` to match the API
    contract.
    """

    id: str | None = None
    email: str | None = None
    organisation_id: str | None = None
    ip: str | None = None
    audiences: Sequence[str] | None = None
    app_version: str | None = None
    platform: str | None = None
    country: str | None = None
    custom_data: Mapping[str, Any] | None = None

    def to_payload(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.id is not None:
            out["id"] = self.id
        if self.email is not None:
            out["email"] = self.email
        if self.organisation_id is not None:
            out["organisation_id"] = self.organisation_id
        if self.ip is not None:
            out["ip"] = self.ip
        if self.audiences is not None:
            out["audiences"] = list(self.audiences)
        if self.app_version is not None:
            out["app_version"] = self.app_version
        if self.platform is not None:
            out["platform"] = self.platform
        if self.country is not None:
            out["country"] = self.country
        if self.custom_data is not None:
            out["customData"] = dict(self.custom_data)
        return out


class APIError(Exception):
    def __init__(self, status_code: int, message: str) -> None:
        self.status_code = status_code
        self.message = message
        super().__init__(f"redpennon: api error {status_code}: {message}")


class Client:
    """HTTP client for the RedPennon API."""

    def __init__(
        self,
        *,
        api_key: str,
        timeout: float = 30.0,
        client: httpx.Client | None = None,
    ) -> None:
        self._api_key = api_key
        self._owns_client = client is None
        self._client = client or httpx.Client(timeout=timeout)

    @property
    def api_key(self) -> str:
        return self._api_key

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
