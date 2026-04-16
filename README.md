# @atlasent/mcp-server

MCP server that exposes AtlaSent **evaluate** and **verify-permit** as tools any MCP-compatible AI agent can call.

Built with the [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) and designed to be fail-closed — any error automatically returns a **deny** decision.

## Tools

### `evaluate`

Evaluate a proposed action against AtlaSent safety policies.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action_type` | string | yes | The type of action (e.g. `deploy`, `release`, `merge`) |
| `actor_id` | string | yes | Identifier for the actor performing the action |
| `environment` | string | yes | Target environment (e.g. `production`, `staging`) |
| `approvals` | string[] | no | Approval identifiers already obtained |
| `change_window` | string | no | ISO-8601 time window for the scheduled change |

**Returns:** `{ decision, permit_token }`

### `verify_permit`

Verify a previously issued permit token.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `permit_token` | string | yes | Permit token from a prior `evaluate` call |
| `action_type` | string | yes | The type of action being verified |
| `actor_id` | string | yes | Identifier for the actor |
| `environment` | string | yes | Target environment |
| `approvals` | string[] | no | Approval identifiers already obtained |
| `change_window` | string | no | ISO-8601 time window for the scheduled change |

**Returns:** `{ outcome, valid }`

## Configuration

The server is configured via environment variables:

| Variable | Required | Description |
|---|---|---|
| `ATLASENT_API_KEY` | yes | API key for authenticating with AtlaSent |
| `ATLASENT_ANON_KEY` | no | Anonymous/public key sent as `x-anon-key` header |
| `ATLASENT_BASE_URL` | no | Base URL for the AtlaSent API (default: `https://api.atlasent.com`) |

## Installation

```bash
npm install @atlasent/mcp-server
```

Or run directly with npx:

```bash
npx @atlasent/mcp-server
```

## Usage with Claude Desktop

Add the following to your Claude Desktop configuration file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": {
        "ATLASENT_API_KEY": "your-api-key-here",
        "ATLASENT_ANON_KEY": "your-anon-key-here",
        "ATLASENT_BASE_URL": "https://api.atlasent.com"
      }
    }
  }
}
```

### Using a local installation

If you prefer to install globally first:

```bash
npm install -g @atlasent/mcp-server
```

Then use the binary directly:

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "atlasent-mcp-server",
      "env": {
        "ATLASENT_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run
ATLASENT_API_KEY=key npm start
```

## Fail-Closed Design

Every tool handler is wrapped in a try/catch. If the AtlaSent API is unreachable, returns an error, or anything unexpected happens, the tool returns a **deny** decision rather than silently allowing an action. This ensures safety defaults are always enforced.

## License

[MIT](LICENSE)
