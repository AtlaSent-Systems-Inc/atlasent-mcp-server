# Release Notes

## v2.11.0 — 2026-06-09

**Correction (2026-08-30):** this section previously read "Unreleased —
prepared, not yet published," stating no version past v1.0.0 had ever
shipped and that `git tag -l` showed no `v*` tags. Both claims were wrong —
they were based on an incomplete local git clone rather than the live
registries. Verified directly against the npm registry
(`registry.npmjs.org/@atlasent/mcp-server`) and GitHub: **`2.11.0` has been
published to npm since 2026-06-09** (`dist-tags.latest: "2.11.0"`, published
via a manual `workflow_dispatch` run of `publish.yml`, not a tag push), and
the `v2.11.0` git tag has existed since 2026-06-10 (`create-v2-11-0-tag.yml`
run #1). Submission to the **MCP Registry remains genuinely outstanding**
as of 2026-08-30 — confirmed via a live query against
`registry.modelcontextprotocol.io`, which returns zero results for
`atlasent`.

### Tool surface growth since v1.0.0

The two-tool v1.0.0 surface (`evaluate`, `verify_permit`) has grown into a
much larger tool inventory (use MCP `tools/list` on the installed version for
the exact, current set):

- `deploy_service` — protected two-layer deployment demo (authorize + verify
  the outer `agent.tool.invoke` gate, then authorize + verify the
  action-specific `production.deploy` permit) proving the enforcement
  ordering end to end.
- `atlasent_evaluate` / `atlasent_verify_permit` — hosted V1 API-facing
  variants with a richer context envelope than the local demo tools.
- `atlasent_lookup_action` — read-only Canon lookup for Action Types, gate
  flags, authorization patterns, and evidence requirements.
- `atlasent_atlas_lookup` — read-only lookup of canonical AtlaSent concepts
  (Authority, Policy, Decision, Permit, Verification, Evidence, Gate, Trust
  Root).
- `atlasent_integrity_audit` — read-only Authority-graph consistency audit
  (hosted mode only).
- `atlasent_trajectory_verify` — per-step trajectory drift detection.
- Approval workflow tools (`atlasent_create_approval_request`,
  `atlasent_resolve_approval_request`), execution-evidence recording
  (`atlasent_record_execution_evaluation`), and Wave B tools
  (`atlasent_evaluate_many`, `atlasent_evaluate_stream`, `atlasent_query`).
- Compliance tools: SCIM, SIEM config, evidence export.
- VQP snapshot generation, verification, and drift-event tools.
- A Streamable HTTP transport in addition to stdio.

### Distribution changes since v1.0.0

- `server.json` added for MCP Registry submission
  (`io.github.atlasent-systems-inc/mcp-server`).
- `smithery.yaml` added for Smithery discovery/install.
- README now documents Cursor and Windsurf install, in addition to Claude
  Desktop.

### Install

```bash
npm install @atlasent/mcp-server
```

See the [README](./README.md) for Claude Desktop / Cursor / Windsurf config
blocks and local/remote mode setup.

---

# Release Notes — v1.0.0

**Release date:** 2026-04-17

## AtlaSent MCP Server v1.0.0

First stable release of the AtlaSent MCP server. Works with Claude Desktop, Cursor, Claude Code, and any MCP-compatible client.

### Tools exposed

| Tool | Description |
|---|---|
| `evaluate` | Authorize an action — returns `decision`, `permit_token`, `audit_hash` |
| `verify_permit` | Consume a permit at execution time — enforces single-use |

### Modes

- **Local mode** (no API key): In-process rules engine, zero network calls. Ideal for demos and offline development.
- **Remote mode** (`ATLASENT_API_KEY` set): Routes to the hosted AtlaSent backend. Full audit chain, multi-org policies.

### Install (Claude Desktop)

```json
{
  "mcpServers": {
    "atlasent": {
      "command": "npx",
      "args": ["-y", "@atlasent/mcp-server"],
      "env": { "ATLASENT_API_KEY": "ask_live_xxx" }
    }
  }
}
```

### Local demo (no credentials)

```bash
git clone https://github.com/AtlaSent-Systems-Inc/atlasent-mcp-server
cd atlasent-mcp-server && npm install && npm run demo
```

### Stability guarantees

The `evaluate` and `verify_permit` tool schemas are stable as of v1.0.0. Tool names and required parameters will not change without a major version bump.
