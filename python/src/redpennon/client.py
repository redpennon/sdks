from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, MutableMapping, Sequence

import httpx

# Production evaluation API origin (no trailing slash).
DEFAULT_API_BASE_URL = "https://api.redpennon.dev"


@dataclass(frozen=True, slots=True)
class UserContext:
    """Maps to the evaluation API ``user`` object."""

    id: str | None = None
    email: str | None = None
    organisation_id: str | None = None
    ip: str | None = None
    audiences: Sequence[str] | None = None

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
        return out


@dataclass(frozen=True, slots=True)
class EvaluateResponse:
    feature: str
    variation: str
    variables: Mapping[str, Any]
    reason: str

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> EvaluateResponse:
        return cls(
            feature=str(data["feature"]),
            variation=str(data["variation"]),
            variables=data.get("variables") or {},
            reason=str(data["reason"]),
        )


@dataclass(frozen=True, slots=True)
class BatchResponse:
    results: Mapping[str, EvaluateResponse]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> BatchResponse:
        raw = data.get("results") or {}
        results: dict[str, EvaluateResponse] = {}
        for k, v in raw.items():
            results[str(k)] = EvaluateResponse.from_dict(v)
        return cls(results=results)


class APIError(Exception):
    def __init__(self, status_code: int, message: str) -> None:
        self.status_code = status_code
        self.message = message
        super().__init__(f"redpennon: api error {status_code}: {message}")


class Client:
    """HTTP client for the RedPennon evaluation API at DEFAULT_API_BASE_URL."""

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

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def _post(self, path: str, body: MutableMapping[str, Any]) -> Any:
        url = f"{DEFAULT_API_BASE_URL}{path}"
        r = self._client.post(
            url,
            json=body,
            headers={
                "X-Api-Key": self._api_key,
                "Content-Type": "application/json",
            },
        )
        if r.status_code < 200 or r.status_code >= 300:
            try:
                err = r.json().get("error", "")
            except Exception:
                err = r.text
            raise APIError(r.status_code, str(err) if err else r.text)
        return r.json()

    def evaluate(
        self,
        *,
        feature: str,
        user: UserContext | Mapping[str, Any] | None = None,
    ) -> EvaluateResponse:
        body: dict[str, Any] = {"feature": feature}
        if user is not None:
            if isinstance(user, UserContext):
                u = user.to_payload()
            else:
                u = dict(user)
            if u:
                body["user"] = u
        data = self._post("/v1/evaluate", body)
        return EvaluateResponse.from_dict(data)

    def evaluate_batch(
        self,
        *,
        features: Sequence[str],
        user: UserContext | Mapping[str, Any] | None = None,
    ) -> BatchResponse:
        body: dict[str, Any] = {"features": list(features)}
        if user is not None:
            if isinstance(user, UserContext):
                u = user.to_payload()
            else:
                u = dict(user)
            if u:
                body["user"] = u
        data = self._post("/v1/evaluate/batch", body)
        return BatchResponse.from_dict(data)
