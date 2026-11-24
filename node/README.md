# @redpennon/node-sdk

[![npm](https://img.shields.io/npm/v/@redpennon/node-sdk)](https://www.npmjs.com/package/@redpennon/node-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/redpennon/sdks/blob/main/LICENSE)

Thin HTTP client for the [RedPennon](https://redpennon.dev) feature flag evaluation API.

## Installation

```bash
npm install @redpennon/node-sdk
```

Requires Node 22+. No runtime dependencies — uses the global `fetch`.

## Quick start

```ts
import { RedPennonClient } from "@redpennon/node-sdk";

const client = new RedPennonClient({ apiKey: "YOUR_ENV_API_KEY" });

// Simple: get the resolved value or your default on any failure.
// The default is the second positional argument.
const darkMode = await client.variableValue("dark-mode-enabled", false);

// With user context (for targeting rules and percentage rollouts).
// Without a user, bucketing has no stable id to hash on.
const user = { id: "user_123", email: "alice@example.com" };
const enabled = await client.variableValue("dark-mode-enabled", false, { user });

// Full result: value + variation + reason.
const result = await client.variable("dark-mode-enabled", { user });
console.log(result.value, result.variation, result.reason);

// Batch: resolve many flags in one round-trip.
const results = await client.variables(["flag-a", "flag-b"], { user });
const flagA = results["flag-a"].value;

// Batch with defaults: keys come from the defaults object.
const flags = await client.variableValues({ "flag-a": false, "flag-b": 0 }, { user });
```

## API

### `new RedPennonClient({ apiKey, baseUrl?, fetchImpl? })`

| Option | Type | Description |
|--------|------|-------------|
| `apiKey` | `string` | Environment API key from the RedPennon dashboard. |
| `baseUrl` | `string?` | Override the API base URL (default: `https://api.redpennon.dev`). |
| `fetchImpl` | `typeof fetch?` | Custom fetch — useful for testing. |

### `client.variableValue(key, defaultValue, { user? }) → Promise<T>`

Returns the resolved value or `defaultValue` on any failure (network error, non-2xx, `value=null`). Use this in production code — your default is the load-bearing contract. The default is positional: passing an options object as the second argument makes that object the default and sends no user context.

### `client.variable(key, { user? }) → Promise<VariableResult>`

Returns the full evaluation result (`value`, `variation`, `reason`, `feature`). Throws `APIError` on network or non-2xx errors.

### `client.variables(keys, { user? }) → Promise<Record<string, VariableResult>>`

Batch evaluation — one HTTP round-trip for multiple flags. Unknown keys return `reason: "variable_not_found"` inline rather than throwing.

### `client.variableValues(defaults, { user? }) → Promise<T>`

Batch counterpart of `variableValue`. The keys of `defaults` are the variables to resolve; each comes back as its served value, or its entry in `defaults` when the platform served no value or the call failed.

## Local development

```bash
npm ci
npm test
npm run build
```

## License

[MIT](../LICENSE) © RedPennon
