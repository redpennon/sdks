# RedPennon client SDKs

Thin HTTP clients for the [evaluation API](https://docs.redpennon.dev) (`POST /v1/evaluate/`, `POST /v1/evaluate/batch/`).

| SDK    | Directory | Package / module                          |
| ------ | --------- | ----------------------------------------- |
| Node   | `node/`   | npm: `@redpennon/node-sdk`                |
| Go     | `go/`     | module: `github.com/redpennon/sdks/go`    |
| Python | `python/` | PyPI-style package: `redpennon` (src layout) |

## Local development

- **Node** (requires Node 20+): `cd node && npm ci && npm test`
- **Go** (requires Go 1.22+): `cd go && go test ./...`
- **Python** (requires Python 3.12+): `cd python && python -m venv .venv && source .venv/bin/activate && pip install -e '.[dev]' && pytest`

All SDKs call production `https://api.redpennon.dev` only. Pass a custom `httpx.Client` (e.g. with `MockTransport`) in tests, or `fetchImpl` in Node.

Authentication: `X-Api-Key` with the environment API key (UUID).
