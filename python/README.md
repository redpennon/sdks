# redpennon · Python SDK

[![PyPI](https://img.shields.io/pypi/v/redpennon)](https://pypi.org/project/redpennon/)
[![Python](https://img.shields.io/pypi/pyversions/redpennon)](https://pypi.org/project/redpennon/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/redpennon/sdks/blob/main/LICENSE)

Thin HTTP client for the [RedPennon](https://redpennon.dev) feature flag evaluation API.

## Installation

```bash
pip install redpennon
```

Requires Python 3.12+ and [`httpx`](https://www.python-httpx.org/).

## Quick start

```python
from redpennon import Client, UserContext

client = Client(api_key="YOUR_ENV_API_KEY")

# Simple: get the resolved value or your default on any failure.
enabled = client.variable_value("dark-mode-enabled", default=False)

# With user context (for targeting rules).
user = UserContext(id="user_123", email="alice@example.com")
enabled = client.variable_value("dark-mode-enabled", default=False, user=user)

# Full result: value + variation + reason.
result = client.variable("dark-mode-enabled", user=user)
print(result.value, result.variation, result.reason)

# Batch: resolve many flags in one round-trip.
results = client.variables(["flag-a", "flag-b"], user=user)
flag_a = results["flag-a"].value
```

## API

### `Client(api_key, *, base_url=None, http_client=None)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `api_key` | `str` | Environment API key from the RedPennon dashboard. |
| `base_url` | `str \| None` | Override the API base URL (default: `https://api.redpennon.dev`). |
| `http_client` | `httpx.Client \| None` | Custom client — useful for testing with `MockTransport`. |

### `client.variable_value(key, *, default, user=None) → T`

Returns the resolved value or `default` on any failure (network error, non-2xx, `value=null`). Use this in production code — your default is the load-bearing contract.

### `client.variable(key, *, user=None) → VariableResult`

Returns the full evaluation result (`value`, `variation`, `reason`, `feature`). Raises `APIError` on network or non-2xx errors.

### `client.variables(keys, *, user=None) → dict[str, VariableResult]`

Batch evaluation — one HTTP round-trip for multiple flags. Unknown keys return `reason="variable_not_found"` inline rather than raising.

## Local development

```bash
pip install -e '.[dev]'
pytest
```

## License

[MIT](../LICENSE) © RedPennon
