"""RedPennon API client."""

from redpennon.client import (
    APIError,
    Client,
    DEFAULT_API_BASE_URL,
    EvaluationReason,
    UserContext,
    VariableResult,
)

__all__ = [
    "APIError",
    "Client",
    "DEFAULT_API_BASE_URL",
    "EvaluationReason",
    "UserContext",
    "VariableResult",
]

__version__ = "0.1.0"
