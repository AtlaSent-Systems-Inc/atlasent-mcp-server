# @atlasent/mcp-server

MCP server that exposes AtlaSent **evaluate** and **verify-permit** as tools any MCP-compatible AI agent can call.

## Overview

This package implements a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [AtlaSent](https://atlasent.io). It exposes two tools:

- **`evaluate`** — Calls `POST /v1-evaluate` to determine whether an action should be permitted. Returns a `decision` (`allow`/`deny`) and a `permit_token` when allowed.
- **`verify_permit`** — Calls `POST /v1-verify-permit` to verify that a previously issued permit token is still valid. Returns an `outcome` and a `valid` boolean.

The server is **fail-closed**: any error (network failure, non-OK HTTP response, etc.) results in a `deny` response.

## Installation

```bash
npm install @atlasent/mcp-server
```

## Configuration

Configure the server using environment variables:

| Variable             | Required | Description                                      |
|----------------------|----------|--------------------------------------------------|
| `ATLASENT_API_KEY`   | Yes      | Your AtlaSent API key (used as Bearer token)     |
| `ATLASENT_ANON_KEY`  | Yes      | Your AtlaSent anonymous/public key               |
| `ATLASENT_BASE_URL`  | No       | AtlaSent API base URL (default: `https://api.atlasent.io`) |

## Usage

### Claude Desktop

Add the following to your Claude Desktop configuration file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": {
        "ATLASENT_API_KEY": "your-api-key-here",
        "ATLASENT_ANON_KEY": "your-anon-key-here",
        "ATLASENT_BASE_URL": "https://api.atlasent.io"
      }
    }
  }
}
```

### Running directly

```bash
ATLASENT_API_KEY=your-key ATLASENT_ANON_KEY=your-anon-key npx @atlasent/mcp-server
```

## Tools

### `evaluate`

Evaluate whether an action should be permitted by the AtlaSent policy engine.

**Input parameters:**

| Parameter       | Type       | Required | Description                                            |
|-----------------|------------|----------|--------------------------------------------------------|
| `action_type`   | `string`   | Yes      | The type of action being evaluated                     |
| `actor_id`      | `string`   | Yes      | The ID of the actor requesting the action              |
| `environment`   | `string`   | Yes      | The environment (e.g., `production`, `staging`)        |
| `approvals`     | `string[]` | No       | List of approver IDs who have approved the action      |
| `change_window` | `string`   | No       | The change window identifier for scheduled maintenance |

**Output:**

```json
{
  "decision": "allow",
  "permit_token": "eyJ..."
}
```

On error (fail-closed):
```json
{ "decision": "deny" }
```

---

### `verify_permit`

Verify that a previously issued permit token is still valid.

**Input parameters:**

| Parameter       | Type       | Required | Description                                            |
|-----------------|------------|----------|--------------------------------------------------------|
| `permit_token`  | `string`   | Yes      | The permit token returned from `evaluate`              |
| `action_type`   | `string`   | Yes      | The type of action being evaluated                     |
| `actor_id`      | `string`   | Yes      | The ID of the actor requesting the action              |
| `environment`   | `string`   | Yes      | The environment (e.g., `production`, `staging`)        |
| `approvals`     | `string[]` | No       | List of approver IDs who have approved the action      |
| `change_window` | `string`   | No       | The change window identifier for scheduled maintenance |

**Output:**

```json
{
  "outcome": "allowed",
  "valid": true
}
```

On error (fail-closed):
```json
{ "outcome": "deny", "valid": false }
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type-check
npm run lint
```

## License

MIT — see [LICENSE](LICENSE) for details.
