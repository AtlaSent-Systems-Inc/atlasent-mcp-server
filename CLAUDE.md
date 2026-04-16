# @atlasent/mcp-server

MCP server that exposes AtlaSent policy evaluation to any MCP-compatible AI agent.

## Architecture

```
src/
  server.ts          — createServer() factory: registers both MCP tools, exports for tests
  index.ts           — CLI entry point: creates server, connects stdio transport
  server.test.ts     — Unit tests (16): mock fetch, use InMemoryTransport + MCP Client
  integration.test.ts — Live API tests: require ATLASENT_API_KEY, skip otherwise
```

Single module, no internal abstractions. `server.ts` owns all logic (API client, tool registration, fail-closed error handling). `index.ts` is just the stdio bootstrap.

## Build & Test

```bash
npm run build          # tsc → dist/
npm test               # node --test dist/server.test.js
npm run test:integration  # requires ATLASENT_API_KEY
```

Tests use Node's built-in test runner (node:test) with the MCP SDK's InMemoryTransport — no test framework deps. Global fetch is mocked per-test via `mock.fn()` and restored in afterEach.

## Key Design Decisions

- **Fail-closed**: every tool handler wraps the API call in try/catch and returns `{ decision: "deny", reason }` with `isError: true` on any failure. The agent never gets a silent pass.
- **Env vars read at call time**: `ATLASENT_BASE_URL`, `ATLASENT_API_KEY`, `ATLASENT_ANON_KEY` are read inside `post()`, not at module load. This lets tests swap credentials between calls.
- **10s request timeout**: `AbortSignal.timeout(10_000)` on every fetch. Prevents a hung API from blocking the agent indefinitely.
- **Tool annotations**: `readOnlyHint: true`, `destructiveHint: false` — both tools are policy checks, not mutations.

## API Endpoints

- `POST /v1-evaluate` — evaluate an action, returns `{ decision, permit_token, reason?, audit_id?, conditions? }`
- `POST /v1-verify-permit` — verify a permit token, returns `{ outcome, valid, reason?, audit_id? }`

Auth: `Authorization: Bearer $ATLASENT_API_KEY`, optional `x-anon-key: $ATLASENT_ANON_KEY`.

## CI/CD

- `.github/workflows/ci.yml` — build + test on push/PR to main, Node 18/20/22 matrix
- `.github/workflows/publish.yml` — build + test + `npm publish --provenance` on `v*` tag push

## npm Publishing

Scoped package `@atlasent/mcp-server` with `publishConfig.access: public`. The `files` field limits the published tarball to `dist/`, `README.md`, and `LICENSE`. Requires `NPM_TOKEN` secret in GitHub repo settings.
