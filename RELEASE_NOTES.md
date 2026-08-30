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

### Tool surface growth since v1.0.0 (what's actually in this published version)

**Correction (2026-08-30, review of this PR):** this section originally
described `main`'s current tool inventory under the `v2.11.0` heading, which
misrepresented several tools as part of the published release when they
were added to `main` only *after* the tag. The published `v2.11.0` was cut
from commit `c3b2add`; verified directly by diffing `src/server.ts` at that
commit against `main`. The list below is now scoped to what `c3b2add`
actually contains — see the "Unreleased" section further down for what has
landed on `main` since.

The two-tool v1.0.0 surface (`evaluate`, `verify_permit`) grew into this by
`v2.11.0`:

- `deploy_service` — protected two-layer deployment demo. **In this
  published version, the outer gate uses the legacy, uncatalogued
  `model.agent.execute_tool` action type**, which has no corresponding
  `action_classes` provisioning path in the runtime — against a real,
  unmodified AtlaSent org this outer gate can only return `NO_ACTION_CLASS`
  deny. See the "Unreleased" section for the fix.
- `atlasent_evaluate` / `atlasent_verify_permit` — hosted V1 API-facing
  variants with a richer context envelope than the local demo tools.
- `atlasent_trajectory_verify` — per-step trajectory drift detection.
- Approval workflow tools (`atlasent_create_approval_request`,
  `atlasent_resolve_approval_request`), execution-evidence recording
  (`atlasent_record_execution_evaluation`), and Wave B tools
  (`atlasent_evaluate_many`, `atlasent_evaluate_stream`).
- Compliance tools: SCIM, SIEM config, evidence export.
- VQP snapshot generation, verification, and drift-event tools.

### Distribution changes since v1.0.0

- `server.json` added for MCP Registry submission
  (`io.github.atlasent-systems-inc/mcp-server`) — **submission itself is
  still outstanding**, see the correction note above the tool list.
- `smithery.yaml` added for Smithery discovery/install.

### Install

```bash
npm install @atlasent/mcp-server
```

See the [README](./README.md) for Claude Desktop / Cursor / Windsurf config
blocks and local/remote mode setup — note the README on `main` describes
the current (unreleased) state, not necessarily what `v2.11.0` ships; the
README bundled into the published npm tarball is frozen as of `c3b2add`.

## Unreleased (on `main`, not yet in a published version or tag)

Landed on `main` after the `v2.11.0` tag (`c3b2add`), with no version bump
or new publish yet:

- **Outer gate migrated to the Canon-backed `agent.tool.invoke`
  action** (`CANON-000026` / `ACT-0029`), replacing the broken
  `model.agent.execute_tool` identity described above. See
  AtlaSent-Systems-Inc/atlasent-mcp-server#121 for the investigation and
  decision record.
- `atlasent_lookup_action` — read-only Canon lookup for Action Types, gate
  flags, authorization patterns, and evidence requirements.
- `atlasent_atlas_lookup` — read-only lookup of canonical AtlaSent concepts
  (Authority, Policy, Decision, Permit, Verification, Evidence, Gate, Trust
  Root).
- `atlasent_integrity_audit` — read-only Authority-graph consistency audit
  (hosted mode only).
- `atlasent_explain_authority`.
- README now documents Cursor and Windsurf install, in addition to Claude
  Desktop.

Anyone relying on the currently-published `2.11.0` package does not have
the above; use MCP `tools/list` on the installed version for the exact,
current set rather than trusting this doc.

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
