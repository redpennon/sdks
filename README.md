# RedPennon client SDKs

Thin HTTP clients for the RedPennon flag platform. See the [docs](https://docs.redpennon.dev) for the current API surface.

| SDK    | Directory | Package / module                          |
| ------ | --------- | ----------------------------------------- |
| Node   | `node/`   | npm: `@redpennon/node-sdk`                |
| Go     | `go/`     | module: `github.com/redpennon/sdks/go`    |
| Python | `python/` | PyPI-style package: `redpennon` (src layout) |

## Local development

- **Node** (requires Node 20+): `cd node && npm ci && npm test`
- **Go** (requires Go 1.22+): `cd go && go test ./...`
- **Python** (requires Python 3.12+): `cd python && python -m venv .venv && source .venv/bin/activate && pip install -e '.[dev]' && pytest`

All SDKs default to production `https://api.redpennon.dev`; pass `baseUrl` (Node), `base_url` (Python), or `WithBaseURL(...)` (Go) to point at a different host (e.g. `http://localhost:8001` for local dev). Pass a custom `httpx.Client` (e.g. with `MockTransport`) in Python tests, `fetchImpl` in Node, or `WithHTTPClient` in Go.

Authentication: `X-API-Key` with the environment API key (UUID).

## API surface (all SDKs)

The SDKs target the variable-key evaluation endpoints (`POST /v1/variables/{key}` for a single flag, `POST /v1/variables` for batch):

- **`variableValue` / `variable_value` / `VariableValue`** — returns just the resolved value or the caller-supplied default on any failure (network, non-2xx, or `value=null`). Use this in application code; the developer-supplied default is the load-bearing contract.
- **`variable` / `Variable`** — returns the full result (`value`, `variation`, `reason`, `feature`) and surfaces errors as `APIError`. Use this for telemetry or per-state UI.
- **`variables` / `Variables`** — batch counterpart. Returns a `{ key: result }` map; unknown keys surface as `variable_not_found` inline rather than failing the batch.
