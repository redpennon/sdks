"""RedPennon API client."""

from importlib.metadata import PackageNotFoundError, version as _pkg_version

from redpennon.client import (
    APIError,
    Client,
    DEFAULT_API_BASE_URL,
    DEFAULT_TIMEOUT_SECONDS,
    EvaluationReason,
    EventPayload,
    TrackEventsResult,
    UserContext,
    VariableResult,
)

__all__ = [
    "APIError",
    "Client",
    "DEFAULT_API_BASE_URL",
    "DEFAULT_TIMEOUT_SECONDS",
    "EvaluationReason",
    "EventPayload",
    "TrackEventsResult",
    "UserContext",
    "VariableResult",
]

try:
    __version__ = _pkg_version("redpennon")
except PackageNotFoundError:  # pragma: no cover - source checkouts
    __version__ = "0.0.0+unknown"
