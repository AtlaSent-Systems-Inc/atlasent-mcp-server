#!/usr/bin/env node
// Re-vendor src/atlasCatalog.ts from the upstream Knowledge Atlas export.
//
// Source of truth: atlasent-docs/architecture/traceability/atlas.json
//   (compiled from concepts.yaml by that repo's tools/generate.py).
// This script only transcribes that JSON into a typed TS module — it never
// invents data. Run it whenever the upstream atlas.json changes.
//
// Usage:
//   node scripts/vendor-atlas.mjs [path/to/atlas.json]
// Default path assumes atlasent-docs is a sibling checkout.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcArg = process.argv[2];
const atlasPath = srcArg
  ? resolve(process.cwd(), srcArg)
  : resolve(here, "..", "..", "atlasent-docs", "architecture", "traceability", "atlas.json");

const data = JSON.parse(readFileSync(atlasPath, "utf8"));
const j = (v) => JSON.stringify(v, null, 2);

const ts = `// GENERATED-DERIVED — do not edit directly.
// Source: atlasent-docs/architecture/traceability/atlas.json
//   (compiled from concepts.yaml by architecture/traceability/tools/generate.py).
// Re-vendor: node scripts/vendor-atlas.mjs [path/to/atlas.json]
// Do NOT hand-edit — edit concepts.yaml upstream and re-vendor.

export interface AtlasConcept {
  id: string;
  term: string;
  kind: string;
  definition: string | null;
  canon: string | null;
  adr: string[];
  product_spec: string[];
  implementation: string[];
  api: string[];
  sdk: string[];
  docs: string[];
  sales: string[];
  status: string;
  depends_on: string[];
  used_by: string[];
  realized_by: string[];
}

export interface AtlasNode {
  id: string;
  name: string;
  kind: string;
  ref: string | null;
  status: string;
  edges: { to: string; type: string }[];
}

export interface AtlasEdge {
  from: string;
  to: string;
  type: string;
}

export const ATLAS_SOURCE = "atlasent-docs/architecture/traceability/atlas.json";

export const ATLAS_CONCEPTS: AtlasConcept[] = ${j(data.concepts)};

export const ATLAS_NODES: AtlasNode[] = ${j(data.atlas_nodes)};

export const ATLAS_EDGES: AtlasEdge[] = ${j(data.edges)};
`;

writeFileSync(resolve(here, "..", "src", "atlasCatalog.ts"), ts);
console.log(
  `vendored src/atlasCatalog.ts from ${atlasPath} — ` +
    `${data.concepts.length} concepts, ${data.atlas_nodes.length} nodes, ${data.edges.length} edges`,
);
