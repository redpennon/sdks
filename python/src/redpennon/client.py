from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Iterable, Literal, Mapping, Sequence, TypeVar
from urllib.parse import quote

import httpx

DEFAULT_API_BASE_URL = "https://api.redpennon.dev"

_LOG = logging.getLogger("redpennon")

T = TypeVar("T")

EvaluationReason = Literal[
    "targeting_rule_matched",
    "default_variation",
    "no_rule_matched",
    "targeting_disabled",
    "feature_complete",
    "feature_deleted",
    "feature_archived",
    "self_targeting_override",
    "variable_not_found",
]


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
    """Raised by ``Client.variable`` / ``Client.variables`` on non-2xx
    responses or transport errors. ``Client.variable_value`` swallows
    these and substitutes the caller's default."""

    def __init__(self, status_code: int, message: str) -> None:
        self.status_code = status_code
        self.message = message
        super().__init__(f"redpennon: api error {status_code}: {message}")


@dataclass(frozen=True, slots=True)
class VariableResult:
    """Server-side evaluation outcome for a single variable.

    ``value`` is ``None`` whenever the platform served no value
    (unknown key, targeting disabled, feature deleted/archived) —
    callers using :meth:`Client.variable` directly should treat the
    null case the same way :meth:`Client.variable_value` does (fall
    back to a default). ``variation`` and ``feature`` are likewise
    ``None`` in those cases.
    """

    key: str
    value: Any
    variation: str | None
    reason: EvaluationReason
    feature: str | None

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "VariableResult":
        return cls(
            key=payload["key"],
            value=payload.get("value"),
            variation=payload.get("variation"),
            reason=payload.get("reason"),  # type: ignore[arg-type]
            feature=payload.get("feature"),
        )


class Client:
    """HTTP client for the RedPennon variable-key evaluation API.

    Two evaluation entry points cover the two ergonomics teams reach
    for:

      * :meth:`variable_value` — "give me the value or this fallback".
        Swallows network and API errors and returns the caller's
        default. This is the load-bearing contract: the developer's
        default *always* wins on any failure, so the calling app
        cannot crash because RedPennon is unreachable.

      * :meth:`variable` — "give me the full result object" with
        ``variation``, ``reason``, ``feature``, etc. Surfaces errors
        as :class:`APIError`; opting in to the result shape opts in
        to error handling.

    Batch evaluation via :meth:`variables` lets one HTTP round-trip
    resolve many flags against the same user context.
    """

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = DEFAULT_API_BASE_URL,
        timeout: float = 30.0,
        client: httpx.Client | None = None,
    ) -> None:
        self._api_key = api_key
        self._origin = base_url.rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx.Client(timeout=timeout)

    @property
    def api_key(self) -> str:
        return self._api_key

    @property
    def base_url(self) -> str:
        return self._origin

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    # ------------------------------------------------------------------
    # Evaluation

    def variable(
        self,
        key: str,
        *,
        user: UserContext | None = None,
    ) -> VariableResult:
        """Resolve one variable to its full :class:`VariableResult`."""
        body: dict[str, Any] = {}
        if user is not None:
            body["user"] = user.to_payload()
        response = self._post(
            f"/v1/variables/{quote(key, safe='')}", body,
        )
        return VariableResult.from_payload(response.json())

    def variable_value(
        self,
        key: str,
        *,
        default: T,
        user: UserContext | None = None,
    ) -> T:
        """Resolve a variable and return its value, or ``default`` on
        any failure (unreachable API, non-2xx, ``value=None``)."""
        try:
            result = self.variable(key, user=user)
        except (APIError, httpx.HTTPError) as exc:
            _LOG.warning("redpennon: variable_value(%r) failed: %s", key, exc)
            return default
        return default if result.value is None else result.value  # type: ignore[return-value]

    def variables(
        self,
        keys: Iterable[str],
        *,
        user: UserContext | None = None,
    ) -> dict[str, VariableResult]:
        """Resolve a batch of variables in one HTTP round-trip."""
        body: dict[str, Any] = {"keys": list(keys)}
        if user is not None:
            body["user"] = user.to_payload()
        response = self._post("/v1/variables", body)
        results = response.json().get("results", {})
        return {k: VariableResult.from_payload(v) for k, v in results.items()}

    # ------------------------------------------------------------------
    # Internal HTTP

    def _post(self, path: str, body: Mapping[str, Any]) -> httpx.Response:
        response = self._client.post(
            f"{self._origin}{path}",
            headers={
                "X-API-Key": self._api_key,
                "Content-Type": "application/json",
            },
            json=body,
        )
        if response.status_code // 100 != 2:
            raise APIError(
                response.status_code,
                self._error_message(response),
            )
        return response

    @staticmethod
    def _error_message(response: httpx.Response) -> str:
        try:
            payload = response.json()
        except ValueError:
            return response.text or response.reason_phrase
        if isinstance(payload, dict) and "error" in payload:
            return str(payload["error"])
        return response.reason_phrase
