# @redpennon/node-sdk

[![npm](https://img.shields.io/npm/v/@redpennon/node-sdk)](https://www.npmjs.com/package/@redpennon/node-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/redpennon/sdks/blob/main/LICENSE)

Thin HTTP client for the [RedPennon](https://redpennon.dev) feature flag evaluation API.

## Installation

```bash
npm install @redpennon/node-sdk
```

Requires Node 20+. No runtime dependencies — uses the global `fetch`.

## Quick start

```ts
import { RedPennonClient } from "@redpennon/node-sdk";

const client = new RedPennonClient({ apiKey: "YOUR_ENV_API_KEY" });

// Simple: get the resolved value or your default on any failure.
const enabled = await client.variableValue("dark-mode-enabled", {
  default: false,
});

// With user context (for targeting rules).
const user = { id: "user_123", email: "alice@example.com" };
const enabled = await client.variableValue("dark-mode-enabled", {
  default: false,
  user,
});

// Full result: value + variation + reason.
const result = await client.variable("dark-mode-enabled", { user });
console.log(result.value, result.variation, result.reason);

// Batch: resolve many flags in one round-trip.
const results = await client.variables(["flag-a", "flag-b"], { user });
const flagA = results["flag-a"].value;
```

## API

### `new RedPennonClient({ apiKey, baseUrl?, fetchImpl? })`

| Option | Type | Description |
|--------|------|-------------|
| `apiKey` | `string` | Environment API key from the RedPennon dashboard. |
| `baseUrl` | `string?` | Override the API base URL (default: `https://api.redpennon.dev`). |
| `fetchImpl` | `typeof fetch?` | Custom fetch — useful for testing. |

### `client.variableValue(key, { default, user? }) → Promise<T>`

Returns the resolved value or `default` on any failure (network error, non-2xx, `value=null`). Use this in production code — your default is the load-bearing contract.

### `client.variable(key, { user? }) → Promise<VariableResult>`

Returns the full evaluation result (`value`, `variation`, `reason`, `feature`). Throws `APIError` on network or non-2xx errors.

### `client.variables(keys, { user? }) → Promise<Record<string, VariableResult>>`

Batch evaluation — one HTTP round-trip for multiple flags. Unknown keys return `reason: "variable_not_found"` inline rather than throwing.

## Local development

```bash
npm ci
npm test
npm run build
```

## License

[MIT](../LICENSE) © RedPennon
