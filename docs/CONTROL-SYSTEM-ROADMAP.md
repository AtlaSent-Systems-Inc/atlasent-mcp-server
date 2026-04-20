# AtlaSent Control System Roadmap — atlasent-mcp-server

> **Role:** MCP server that wraps LLM tool calls through `authorize()` before execution. Already fail-closed on error (per audit: `src/engine.ts:47-48` `denyDecision()`; `src/server.ts:145-160` only executes on `decision === "allow"`). M3 tightens the contract.
>
> **Master plan:** `atlasent-systems-inc/atlasent:docs/CONTROL-SYSTEM-ROADMAP.md`
>
> **Branch:** `claude/audit-atlasent-system-lhVC5`

## Ground truth (from audit)
- `src/engine.ts:47-48` wraps `authorize()` call in try/catch → `denyDecision()` on throw. Good.
- `src/server.ts:145-160` — `deploy_service` tool only runs on allow. Good.
- **Gap:** signature not verified locally before executing; no `consume` call.

---

## M1 — No work
## M2 — No work

---

## M3 — SDK Tightening (PRIMARY)

### Update `src/engine.ts`
- [ ] Add JWKS client (TS: use `jose` library for Ed25519 verify via JWKS URL)
- [ ] Modify `authorize()` to: call `/v1/evaluate` → verify Ed25519 signature locally → `POST /v1/permits/:id/consume` → only then return `decision: "allow"`
- [ ] Any step failure → `denyDecision(reason)`
- [ ] Keep the try/catch wrapper — fail-closed semantics unchanged

### Update `src/server.ts`
- [ ] `deploy_service` tool (`lines 142-173`) already checks `decision.decision !== "allow"` and blocks — no change needed once `authorize()` is upgraded
- [ ] Every NEW tool added must call `authorize()`; enforce via helper `gatedTool(name, handler)`

### `verify_permit` MCP tool
- [ ] Keep as a diagnostic tool (customer ops can call it to inspect a permit's state)
- [ ] Document that it is NOT part of the enforcement path (enforcement is inline in `authorize()`)

### Tests
- [ ] Replay: call `deploy_service` twice with same evaluation context — first succeeds, second blocks (permit already consumed)
- [ ] JWKS outage → denyDecision → tool returns blocked
- [ ] Tampered signature → denyDecision

---

## M4 — Deployment

- [ ] If this MCP server is deployed as a customer-facing service, place it behind the M4 gateway
- [ ] Document deployment topology in README

---

## Cross-repo Dependencies

- **Depends on:** `atlasent-api` M1 (JWKS + consume)
- **Blocks:** nothing external (this is a leaf consumer)

---

## Verification (repo-local)

- Run against local `atlasent-api` with M1 merged
- Invoke `deploy_service` tool twice — second call must block with "permit already consumed"
- Kill `atlasent-api` → next `deploy_service` call denies (fail-closed on network error; behavior already present, keep green)

## PR Convention

`[M3] atlasent-mcp-server: verify Ed25519 + consume in authorize()`
