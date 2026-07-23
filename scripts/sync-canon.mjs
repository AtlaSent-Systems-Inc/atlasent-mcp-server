#!/usr/bin/env node
// Sync the Canon snapshots consumed by the MCP server from the atlasent
// compiler output. Run from a checkout where ../atlasent is present:
//
//   node scripts/sync-canon.mjs
//
// Or point it at an explicit generated/ directory (used by the
// canon-mirror-drift CI guard, where the source repo is checked out into a
// subdirectory rather than a sibling):
//
//   node scripts/sync-canon.mjs path/to/atlasent/generated
//
// Emits (committed, GENERATED-DERIVED):
//   src/canonCatalog.ts  — the action catalog (with canon_id)
//   src/canonGraph.ts    — per-action knowledge-graph neighborhood + compliance
//
// The Canon is the single source of truth (contract/canonical-actions/ACT-*.yaml
// → generated/ in the atlasent repo). These files are a read-only mirror so the
// MCP server can answer from compiler output instead of guessing.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Optional positional arg: the atlasent `generated/` directory. Defaults to a
// sibling checkout (../atlasent/generated) for local use. The output is
// identical regardless of source location — only WHERE the Canon is read from
// changes.
const GEN = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : join(here, "..", "..", "atlasent", "generated");

const spec = JSON.parse(readFileSync(join(GEN, "act-spec-index.json"), "utf8"));
const graph = JSON.parse(readFileSync(join(GEN, "authorization-graph.json"), "utf8"));

const nodeLabel = new Map(graph.nodes.map((n) => [n.id, n.label]));
const tail = (id) => id.split(":").slice(1).join(":");

function neighborhood(slug) {
  const src = `action:${slug}`;
  const out = { requires: [], produces: [], assertions: [], frameworks: [], controls: [], domain: null, pattern: null };
  for (const e of graph.edges) {
    if (e.from !== src) continue;
    if (e.type === "REQUIRES") out.requires.push(tail(e.to));
    else if (e.type === "PRODUCES") out.produces.push(tail(e.to));
    else if (e.type === "REQUIRES_ASSERTION") out.assertions.push(tail(e.to));
    else if (e.type === "MAPS_TO") out.frameworks.push(tail(e.to));
    else if (e.type === "SATISFIES") out.controls.push(nodeLabel.get(e.to) ?? tail(e.to));
    else if (e.type === "BELONGS_TO") out.domain = tail(e.to);
    else if (e.type === "IMPLEMENTS") out.pattern = tail(e.to);
  }
  for (const k of ["requires", "produces", "assertions", "frameworks", "controls"]) out[k].sort();
  return out;
}

const HEADER = (src) =>
  `// GENERATED-DERIVED — do not edit directly.\n` +
  `// Source: atlasent/generated/${src} (from contract/canonical-actions/ACT-*.yaml)\n` +
  `// Regenerate: node scripts/sync-canon.mjs (from a checkout with ../atlasent present)\n\n`;

// ---- canonCatalog.ts ----
const catalogInterface = `export interface ActSpecGateFlags {
  requires_human_approval: boolean;
  requires_mfa: boolean;
  requires_verified_actor: boolean;
  requires_state_snapshot: boolean;
  required_assertion_classes: string[];
}

export interface ActSpecAuthorizationPattern {
  type: string;
  machine_executable: boolean;
  minimum_approvals?: number;
}

export interface ActSpecEntry {
  id: string;
  /** Permanent immutable identifier (CANON-NNNNNN). Stable across slug changes. */
  canon_id: string;
  slug: string;
  display_name: string;
  description: string;
  family: string;
  risk_posture: string;
  ai_risk: string;
  gate_flags: ActSpecGateFlags;
  authorization_pattern: ActSpecAuthorizationPattern;
  regulatory_mappings: Record<string, unknown>[];
  evidence_requirements: Record<string, unknown>;
  use_case: string;
  industries: string[];
}
`;

const catalogEntries = spec.actions.map((a) => ({
  id: a.id,
  canon_id: a.canon_id,
  slug: a.slug,
  display_name: a.display_name,
  description: a.description,
  family: a.family,
  risk_posture: a.risk_posture,
  ai_risk: a.ai_risk,
  gate_flags: a.gate_flags,
  authorization_pattern: a.authorization_pattern,
  regulatory_mappings: a.regulatory_mappings ?? [],
  evidence_requirements: a.evidence_requirements ?? {},
  use_case: a.use_case ?? "",
  industries: a.industries ?? [],
}));

writeFileSync(
  join(here, "..", "src", "canonCatalog.ts"),
  HEADER("act-spec-index.json") +
    catalogInterface +
    `\nexport const CANON_ACT_CATALOG: ActSpecEntry[] = ${JSON.stringify(catalogEntries, null, 2)};\n`,
);

// ---- canonGraph.ts ----
const neighborhoods = {};
for (const a of spec.actions) neighborhoods[a.slug] = neighborhood(a.slug);

const graphInterface = `export interface CanonNeighborhood {
  domain: string | null;
  pattern: string | null;
  requires: string[];
  assertions: string[];
  produces: string[];
  frameworks: string[];
  controls: string[];
}
`;

writeFileSync(
  join(here, "..", "src", "canonGraph.ts"),
  HEADER("authorization-graph.json") +
    graphInterface +
    `\n/** Per-action neighborhood in the Authorization Knowledge Graph, keyed by slug. */\n` +
    `export const CANON_ACTION_GRAPH: Record<string, CanonNeighborhood> = ${JSON.stringify(neighborhoods, null, 2)};\n`,
);

console.log(`synced ${catalogEntries.length} actions → canonCatalog.ts + canonGraph.ts`);
