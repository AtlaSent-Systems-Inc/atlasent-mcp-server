// GENERATED-DERIVED — do not edit directly.
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

export const ATLAS_CONCEPTS: AtlasConcept[] = [
  {
    "id": "consequential-action",
    "term": "Consequential Action",
    "kind": "concept",
    "definition": "../canon/008-consequence-model.md",
    "canon": "canon/008 (Consequence Model)",
    "adr": [
      "ADR-040",
      "ADR-041"
    ],
    "product_spec": [
      "execution-authority-model.md"
    ],
    "implementation": [
      "atlasent-api: supabase/functions/_shared/protected-actions.ts",
      "atlasent-api: action_classes (slug identity)"
    ],
    "api": [
      "POST /v1/evaluate (action.type)"
    ],
    "sdk": [
      "evaluate({ action })"
    ],
    "docs": [
      "atlasent-console: How It Works",
      "Enterprise Architecture"
    ],
    "sales": [
      "Executive Brief",
      "CISO Guide",
      "Platform Guide"
    ],
    "status": "active",
    "depends_on": [],
    "used_by": [
      "runtime-authority",
      "evidence",
      "policy"
    ],
    "realized_by": [
      "executive-brief",
      "governance-kits"
    ]
  },
  {
    "id": "assertion",
    "term": "Assertion",
    "kind": "concept",
    "definition": "../canon/007-assertion-model.md",
    "canon": "canon/007 (Assertion Model)",
    "adr": [
      "ADR-041",
      "ADR-042"
    ],
    "product_spec": [
      "fact-issuer-trust-registry.md"
    ],
    "implementation": [
      "atlasent-api: v1-assertion-ingest, v1-assertions, v1-signals"
    ],
    "api": [
      "POST /v1/assertions",
      "POST /v1/signals"
    ],
    "sdk": [
      "context.assertions (input)"
    ],
    "docs": [
      "Enterprise Architecture (assertion framework)"
    ],
    "sales": [
      "Assertion-flow diagram"
    ],
    "status": "active",
    "depends_on": [],
    "used_by": [
      "trusted-assertion"
    ],
    "realized_by": [
      "assertion-ingest",
      "connector-framework",
      "enterprise-architecture",
      "github-connector",
      "slack-connector",
      "stripe-connector"
    ]
  },
  {
    "id": "trust-root",
    "term": "Trust Root / Issuer Registry",
    "kind": "concept",
    "definition": "../canon/006-trust-model.md",
    "canon": "canon/006 (Trust Model)",
    "adr": [
      "ADR-019",
      "ADR-042",
      "ADR-046"
    ],
    "product_spec": [
      "fact-issuer-trust-registry.md",
      "identity-boundary-mapping.md"
    ],
    "implementation": [
      "atlasent-keys: .well-known/atlasent-verifier-keys.json (published JWKS — R2 permit / R3 audit public keys)",
      "atlasent-api: ACTOR_TRUSTED_ISSUERS / ASSERTION_TRUSTED_ISSUERS / IDENTITY_TRUSTED_ISSUERS (per-tenant accepted issuers)"
    ],
    "api": [
      "(trust root served from keys.atlasent.io; issuers consulted within POST /v1/evaluate)"
    ],
    "sdk": [
      "JWKS fetched by verifiers / offline audit-verify (select key by kid)"
    ],
    "docs": [
      "Enterprise Architecture (trust boundary)"
    ],
    "sales": [
      "CISO Guide (identity & authorization inputs)"
    ],
    "status": "active",
    "depends_on": [],
    "used_by": [
      "trusted-assertion"
    ],
    "realized_by": []
  },
  {
    "id": "trusted-assertion",
    "term": "Trusted Assertion",
    "kind": "concept",
    "definition": "../canon/006-trust-model.md",
    "canon": "canon/006 (Trust Model)",
    "adr": [
      "ADR-042",
      "ADR-043",
      "ADR-046"
    ],
    "product_spec": [
      "fact-issuer-trust-registry.md",
      "identity-boundary-mapping.md"
    ],
    "implementation": [
      "atlasent-api: _shared/actor_identity.ts",
      "atlasent-api: _shared/identity_assertion.ts",
      "atlasent-api: _shared/mfa-claims.ts"
    ],
    "api": [
      "(verified within POST /v1/evaluate)"
    ],
    "sdk": [
      "identity assertion binding (input)"
    ],
    "docs": [
      "Enterprise Architecture (trust boundary)"
    ],
    "sales": [
      "CISO Guide (identity & authorization inputs)"
    ],
    "status": "active",
    "depends_on": [
      "assertion",
      "trust-root"
    ],
    "used_by": [
      "authority",
      "delegation"
    ],
    "realized_by": [
      "ciso-guide"
    ]
  },
  {
    "id": "caller",
    "term": "Caller",
    "kind": "concept",
    "definition": "../canon/003-ontology.md",
    "canon": "canon/003 (Ontology — Caller)",
    "adr": [
      "ADR-021",
      "ADR-041"
    ],
    "product_spec": [
      "identity-boundary-mapping.md",
      "execution-authority-model.md"
    ],
    "implementation": [
      "atlasent-api: v1-evaluate CDO (actor_id — the caller identity)",
      "atlasent-api: _shared/actor_identity.ts (verified-actor gate; a self-asserted actor_id is not trusted until cryptographically asserted)"
    ],
    "api": [
      "POST /v1/evaluate (actor_id)"
    ],
    "sdk": [
      "evaluate({ actor })"
    ],
    "docs": [
      "How It Works"
    ],
    "sales": [
      "Executive Brief"
    ],
    "status": "active",
    "depends_on": [],
    "used_by": [
      "authority"
    ],
    "realized_by": []
  },
  {
    "id": "authority",
    "term": "Authority",
    "kind": "concept",
    "definition": "../canon/004-authority-model.md",
    "canon": "canon/004 (Authority Model)",
    "adr": [
      "ADR-040",
      "ADR-041"
    ],
    "product_spec": [
      "execution-authority-model.md",
      "enforcement-principles.md"
    ],
    "implementation": [
      "atlasent-api: v1-evaluate/handler.ts (authority resolution)"
    ],
    "api": [
      "POST /v1/evaluate"
    ],
    "sdk": [
      "evaluate()"
    ],
    "docs": [
      "Enterprise Architecture"
    ],
    "sales": [
      "Executive Brief"
    ],
    "status": "active",
    "depends_on": [
      "caller",
      "trusted-assertion",
      "resource",
      "context"
    ],
    "used_by": [
      "runtime-authority",
      "delegation"
    ],
    "realized_by": [
      "enterprise-architecture",
      "executive-brief"
    ]
  },
  {
    "id": "runtime-authority",
    "term": "Runtime Authority",
    "kind": "concept",
    "definition": "../canon/005-authorization-model.md",
    "canon": "canon/005 (Authorization Model)",
    "adr": [
      "ADR-040",
      "ADR-047"
    ],
    "product_spec": [
      "execution-authority-model.md",
      "evaluation-sequence.md"
    ],
    "implementation": [
      "atlasent-api: v1-evaluate/handler.ts",
      "atlasent-api: packages/sdk/src/rules.ts (mirrored to _shared/rules.ts)"
    ],
    "api": [
      "POST /v1/evaluate"
    ],
    "sdk": [
      "evaluate()"
    ],
    "docs": [
      "How It Works",
      "Enterprise Architecture"
    ],
    "sales": [
      "Executive Brief",
      "Deploy Gate"
    ],
    "status": "active",
    "depends_on": [
      "authority",
      "consequential-action"
    ],
    "used_by": [
      "decision"
    ],
    "realized_by": [
      "atlasent-cli",
      "deploy-gate",
      "evaluate-endpoint",
      "floqast-pilot",
      "guard-cli",
      "gxp-starter",
      "llm-middleware",
      "mcp-server",
      "sdk"
    ]
  },
  {
    "id": "policy",
    "term": "Policy",
    "kind": "concept",
    "definition": "../canon/009-policy-model.md",
    "canon": "canon/009 (Policy Model)",
    "adr": [
      "ADR-033",
      "CROSS-002"
    ],
    "product_spec": [
      "POLICY_RULES_FORMATS.md",
      "policy-evaluation-paths.md"
    ],
    "implementation": [
      "atlasent-api: packages/sdk/src/rules.ts (canonical rule engine, mirrored to _shared/rules.ts)",
      "atlasent-api: action_classes + published constraint bundles (versioned, signed; fail-closed when none active)"
    ],
    "api": [
      "POST /v1/evaluate (evaluated against the active published bundle)"
    ],
    "sdk": [
      "rules engine consumed via @atlasent/sdk (SDKs never re-implement policy — CROSS-002)"
    ],
    "docs": [
      "How It Works",
      "Policy authoring"
    ],
    "sales": [
      "Deploy Gate"
    ],
    "status": "active",
    "depends_on": [
      "consequential-action"
    ],
    "used_by": [
      "decision"
    ],
    "realized_by": []
  },
  {
    "id": "decision",
    "term": "Decision",
    "kind": "concept",
    "definition": "../canon/005-authorization-model.md",
    "canon": "canon/005 (Authorization Model)",
    "adr": [
      "ADR-040",
      "ADR-044"
    ],
    "product_spec": [
      "policy-evaluation-paths.md",
      "evaluation-sequence.md"
    ],
    "implementation": [
      "atlasent-api: v1-evaluate/handler.ts (CDO assembly)",
      "atlasent-api: packages/sdk/src/rules.ts (mirrored to _shared/rules.ts)",
      "atlasent-api: v1-decisions-replay"
    ],
    "api": [
      "POST /v1/evaluate (response)"
    ],
    "sdk": [
      "decision (allow|deny|hold|escalate)"
    ],
    "docs": [
      "How It Works"
    ],
    "sales": [
      "Differentiation (Observability/GRC/IAM vs AtlaSent)"
    ],
    "status": "active",
    "depends_on": [
      "runtime-authority",
      "policy"
    ],
    "used_by": [
      "permit",
      "evidence",
      "gate"
    ],
    "realized_by": [
      "evaluate-endpoint"
    ]
  },
  {
    "id": "permit",
    "term": "Permit",
    "kind": "concept",
    "definition": "../canon/010-permit-model.md",
    "canon": "canon/010 (Permit/Instrument Model)",
    "adr": [
      "ADR-040",
      "ADR-044",
      "ADR-045"
    ],
    "product_spec": [
      "permit-as-specification.md"
    ],
    "implementation": [
      "atlasent-api: v1-verify-permit/handler.ts",
      "atlasent-api: _shared/permit-token.ts",
      "atlasent-console: packages/types/src/evaluation.ts (PermitV2 wire type)"
    ],
    "api": [
      "POST /v1/verify-permit"
    ],
    "sdk": [
      "verifyPermit()",
      "withPermit()"
    ],
    "docs": [
      "Enterprise Architecture (evidence & verification)"
    ],
    "sales": [
      "Deploy Gate"
    ],
    "status": "active",
    "depends_on": [
      "decision"
    ],
    "used_by": [
      "verification",
      "gate"
    ],
    "realized_by": [
      "deploy-gate",
      "enterprise-architecture",
      "governance-kits",
      "guard-cli",
      "llm-middleware",
      "mcp-server",
      "platform-guide",
      "sdk"
    ]
  },
  {
    "id": "verification",
    "term": "Verification",
    "kind": "concept",
    "definition": "../canon/012-verification-model.md",
    "canon": "canon/012 (Verification Model)",
    "adr": [
      "ADR-040",
      "ADR-044"
    ],
    "product_spec": [
      "PROOF_VERIFICATION.md"
    ],
    "implementation": [
      "atlasent-api: v1-verify-permit, v1-verify-chain",
      "atlasent-sdk: audit-evidence-package/verify.mjs (offline verifier, ADR-020)"
    ],
    "api": [
      "POST /v1/verify-permit",
      "POST /v1/verify-chain"
    ],
    "sdk": [
      "verifyPermit()",
      "audit-evidence-package/verify.mjs"
    ],
    "docs": [
      "atlasent-console: /verify/audit",
      "Proof verification"
    ],
    "sales": [
      "Customer Assurance"
    ],
    "status": "active",
    "depends_on": [
      "permit",
      "evidence",
      "audit-chain"
    ],
    "used_by": [],
    "realized_by": [
      "audit-verify-cli",
      "ciso-guide",
      "offline-verifier",
      "platform-guide",
      "sdk",
      "verify-endpoints"
    ]
  },
  {
    "id": "evidence",
    "term": "Evidence",
    "kind": "concept",
    "definition": "../canon/011-evidence-model.md",
    "canon": "canon/011 (Evidence Model)",
    "adr": [
      "ADR-040",
      "ADR-045"
    ],
    "product_spec": [
      "evidence-bundles-spec.md",
      "PROOF_VERIFICATION.md"
    ],
    "implementation": [
      "atlasent-api: _shared/audit.ts (hash-linked, Ed25519-signed chain)",
      "atlasent-api: export-audit / evidence-exports"
    ],
    "api": [
      "POST /v1/export-audit",
      "POST /v1/verify-chain"
    ],
    "sdk": [
      "atlasent-sdk audit-evidence-package (verify.mjs, ADR-020)"
    ],
    "docs": [
      "Evidence bundles",
      "atlasent-console: /verify/audit"
    ],
    "sales": [
      "Customer Assurance",
      "CISO Guide (evidence & auditability)"
    ],
    "status": "active",
    "depends_on": [
      "decision",
      "consequential-action"
    ],
    "used_by": [
      "verification",
      "audit-chain"
    ],
    "realized_by": [
      "audit-export",
      "audit-verify-cli",
      "ciso-guide",
      "deploy-gate",
      "enterprise-architecture",
      "executive-brief",
      "floqast-pilot",
      "gxp-starter",
      "offline-verifier"
    ]
  },
  {
    "id": "audit-chain",
    "term": "Audit Chain",
    "kind": "concept",
    "definition": "../canon/003-ontology.md",
    "canon": "canon/003 (Ontology — Audit chain)",
    "adr": [
      "ADR-020",
      "ADR-023",
      "ADR-029"
    ],
    "product_spec": [
      "specs/audit-chain-canonical-form.md"
    ],
    "implementation": [
      "atlasent-api: _shared/audit.ts (hash-linked, Ed25519-signed; chain v5/v6)",
      "atlasent-verify: offline audit-verify CLI (ADR-020; independent, network-free)"
    ],
    "api": [
      "POST /v1/verify-chain",
      "POST /v1/export-audit"
    ],
    "sdk": [
      "atlasent-sdk: audit-evidence-package/verify.mjs (offline verifier)"
    ],
    "docs": [
      "Evidence bundles",
      "atlasent-console: /verify/audit"
    ],
    "sales": [
      "Customer Assurance"
    ],
    "status": "active",
    "depends_on": [
      "evidence"
    ],
    "used_by": [
      "verification"
    ],
    "realized_by": [
      "audit-verify-cli",
      "offline-verifier",
      "verify-endpoints"
    ]
  },
  {
    "id": "gate",
    "term": "Gate",
    "kind": "concept",
    "definition": "../canon/003-ontology.md",
    "canon": "canon/003 (Ontology — Gate; reference-monitor PEP / complete mediation)",
    "adr": [
      "ADR-040",
      "ADR-041"
    ],
    "product_spec": [
      "enforcement-principles.md",
      "execution-authority-model.md"
    ],
    "implementation": [
      "atlasent-action: src/gate.ts (fail-closed CI/CD deploy gate)",
      "atlasent-sdk: protect() / withPermit() (framework guards)",
      "atlasent-mcp-server: authorize-before-execute interception point",
      "atlasent-llm-integrations: LangChain / LlamaIndex tool-call middleware"
    ],
    "api": [
      "(client-side enforcement; calls POST /v1/evaluate + POST /v1/verify-permit)"
    ],
    "sdk": [
      "protect()",
      "withPermit()",
      "@atlasent_guard"
    ],
    "docs": [
      "How It Works",
      "atlasent-action (GitHub) docs"
    ],
    "sales": [
      "Deploy Gate"
    ],
    "status": "active",
    "depends_on": [
      "decision",
      "permit"
    ],
    "used_by": [],
    "realized_by": [
      "deploy-gate",
      "guard-cli",
      "gxp-starter",
      "llm-middleware",
      "mcp-server",
      "sdk"
    ]
  },
  {
    "id": "resource",
    "term": "Resource",
    "kind": "concept",
    "definition": "../canon/003-ontology.md",
    "canon": "canon/003 (Ontology)",
    "adr": [
      "ADR-041",
      "ADR-042"
    ],
    "product_spec": [
      "execution-authority-model.md"
    ],
    "implementation": [
      "atlasent-api: v1-evaluate CDO (resource/target)"
    ],
    "api": [
      "POST /v1/evaluate (resource)"
    ],
    "sdk": [
      "evaluate({ target })"
    ],
    "docs": [
      "How It Works"
    ],
    "sales": [],
    "status": "active",
    "depends_on": [],
    "used_by": [
      "authority"
    ],
    "realized_by": []
  },
  {
    "id": "context",
    "term": "Context",
    "kind": "concept",
    "definition": "../canon/003-ontology.md",
    "canon": "canon/003 (Ontology)",
    "adr": [
      "ADR-041",
      "ADR-042"
    ],
    "product_spec": [
      "policy-evaluation-paths.md"
    ],
    "implementation": [
      "atlasent-api: v1-evaluate CDO (context, context-envelope)"
    ],
    "api": [
      "POST /v1/evaluate (context)"
    ],
    "sdk": [
      "evaluate({ context })"
    ],
    "docs": [
      "How It Works"
    ],
    "sales": [],
    "status": "active",
    "depends_on": [],
    "used_by": [
      "authority"
    ],
    "realized_by": []
  },
  {
    "id": "delegation",
    "term": "Delegation",
    "kind": "concept",
    "definition": "../canon/010-permit-model.md",
    "canon": "canon/010 (Permit/Instrument Model)",
    "adr": [
      "ADR-040",
      "ADR-045"
    ],
    "product_spec": [],
    "implementation": [
      "atlasent-api: delegation-shadow (partial, non-enforcing)"
    ],
    "api": [],
    "sdk": [],
    "docs": [],
    "sales": [],
    "status": "emerging",
    "depends_on": [
      "trusted-assertion",
      "authority"
    ],
    "used_by": [],
    "realized_by": []
  }
];

export const ATLAS_NODES: AtlasNode[] = [
  {
    "id": "deploy-gate",
    "name": "Deploy Gate",
    "kind": "surface",
    "ref": "atlasent-action + atlasent-console: /deploy-gate",
    "status": "active",
    "edges": [
      {
        "to": "gate",
        "type": "realizes"
      },
      {
        "to": "runtime-authority",
        "type": "uses"
      },
      {
        "to": "permit",
        "type": "uses"
      },
      {
        "to": "evidence",
        "type": "produces"
      }
    ]
  },
  {
    "id": "enterprise-architecture",
    "name": "Enterprise Architecture (page)",
    "kind": "doc",
    "ref": "atlasent-console: /enterprise-architecture",
    "status": "active",
    "edges": [
      {
        "to": "assertion",
        "type": "explains"
      },
      {
        "to": "authority",
        "type": "explains"
      },
      {
        "to": "permit",
        "type": "explains"
      },
      {
        "to": "evidence",
        "type": "explains"
      }
    ]
  },
  {
    "id": "executive-brief",
    "name": "Executive Brief",
    "kind": "doc",
    "ref": "atlasent-console: /executive-brief",
    "status": "active",
    "edges": [
      {
        "to": "consequential-action",
        "type": "explains"
      },
      {
        "to": "authority",
        "type": "explains"
      },
      {
        "to": "evidence",
        "type": "explains"
      }
    ]
  },
  {
    "id": "ciso-guide",
    "name": "CISO Evaluation Guide",
    "kind": "doc",
    "ref": "atlasent-console: /ciso-guide",
    "status": "active",
    "edges": [
      {
        "to": "trusted-assertion",
        "type": "explains"
      },
      {
        "to": "verification",
        "type": "explains"
      },
      {
        "to": "evidence",
        "type": "explains"
      }
    ]
  },
  {
    "id": "platform-guide",
    "name": "Platform & IT Evaluation Guide",
    "kind": "doc",
    "ref": "atlasent-console: /platform-guide",
    "status": "active",
    "edges": [
      {
        "to": "permit",
        "type": "explains"
      },
      {
        "to": "verification",
        "type": "explains"
      }
    ]
  },
  {
    "id": "floqast-pilot",
    "name": "Reference Pilot",
    "kind": "pilot",
    "ref": "design partner (prospective)",
    "status": "prospective",
    "edges": [
      {
        "to": "deploy-gate",
        "type": "uses"
      },
      {
        "to": "runtime-authority",
        "type": "relies_on"
      },
      {
        "to": "evidence",
        "type": "relies_on"
      }
    ]
  },
  {
    "id": "mcp-server",
    "name": "MCP Server",
    "kind": "surface",
    "ref": "atlasent-mcp-server (@atlasent/mcp-server): atlasent_evaluate, atlasent_verify_permit",
    "status": "active",
    "edges": [
      {
        "to": "gate",
        "type": "realizes"
      },
      {
        "to": "runtime-authority",
        "type": "uses"
      },
      {
        "to": "permit",
        "type": "uses"
      }
    ]
  },
  {
    "id": "sdk",
    "name": "AtlaSent SDK",
    "kind": "surface",
    "ref": "atlasent-sdk (@atlasent/sdk npm, atlasent PyPI): protect() / withPermit()",
    "status": "active",
    "edges": [
      {
        "to": "gate",
        "type": "realizes"
      },
      {
        "to": "runtime-authority",
        "type": "uses"
      },
      {
        "to": "permit",
        "type": "uses"
      },
      {
        "to": "verification",
        "type": "uses"
      }
    ]
  },
  {
    "id": "llm-middleware",
    "name": "LLM Framework Middleware",
    "kind": "surface",
    "ref": "atlasent-llm-integrations: LangChain / LlamaIndex tool-call guards (TS + Python)",
    "status": "active",
    "edges": [
      {
        "to": "gate",
        "type": "realizes"
      },
      {
        "to": "runtime-authority",
        "type": "uses"
      },
      {
        "to": "permit",
        "type": "uses"
      }
    ]
  },
  {
    "id": "evaluate-endpoint",
    "name": "Evaluate API",
    "kind": "surface",
    "ref": "atlasent-api: v1-evaluate/handler.ts — POST /v1/evaluate",
    "status": "active",
    "edges": [
      {
        "to": "runtime-authority",
        "type": "realizes"
      },
      {
        "to": "decision",
        "type": "realizes"
      }
    ]
  },
  {
    "id": "verify-endpoints",
    "name": "Verify API",
    "kind": "surface",
    "ref": "atlasent-api: v1-verify-permit, v1-verify-chain — POST /v1/verify-permit, /v1/verify-chain",
    "status": "active",
    "edges": [
      {
        "to": "verification",
        "type": "realizes"
      },
      {
        "to": "audit-chain",
        "type": "realizes"
      }
    ]
  },
  {
    "id": "assertion-ingest",
    "name": "Assertion Ingest API",
    "kind": "surface",
    "ref": "atlasent-api: v1-assertion-ingest, v1-assertions, v1-signals — POST /v1/assertions, /v1/signals",
    "status": "active",
    "edges": [
      {
        "to": "assertion",
        "type": "realizes"
      }
    ]
  },
  {
    "id": "offline-verifier",
    "name": "Offline Audit Verifier",
    "kind": "surface",
    "ref": "atlasent-sdk: audit-evidence-package/verify.mjs (ADR-020)",
    "status": "active",
    "edges": [
      {
        "to": "audit-chain",
        "type": "realizes"
      },
      {
        "to": "verification",
        "type": "realizes"
      },
      {
        "to": "evidence",
        "type": "relies_on"
      }
    ]
  },
  {
    "id": "audit-verify-cli",
    "name": "Offline Audit-Verify CLI (Go)",
    "kind": "product",
    "ref": "atlasent-verify: cmd/atlasent-audit-verify — source-open, network-free, Sigstore-signed (ADR-020); the independent parity implementation of verify.mjs",
    "status": "active",
    "edges": [
      {
        "to": "audit-chain",
        "type": "realizes"
      },
      {
        "to": "verification",
        "type": "realizes"
      },
      {
        "to": "evidence",
        "type": "relies_on"
      }
    ]
  },
  {
    "id": "audit-export",
    "name": "Audit / Evidence Export",
    "kind": "surface",
    "ref": "atlasent-api: export-audit, evidence-exports — POST /v1/export-audit",
    "status": "active",
    "edges": [
      {
        "to": "evidence",
        "type": "produces"
      }
    ]
  },
  {
    "id": "deploy-gate-action",
    "name": "Deploy Gate (GitHub Action)",
    "kind": "product",
    "ref": "atlasent-action: composite GitHub Action for production deploy gating",
    "status": "active",
    "edges": [
      {
        "to": "deploy-gate",
        "type": "uses"
      }
    ]
  },
  {
    "id": "guard-cli",
    "name": "Guard CLI",
    "kind": "product",
    "ref": "atlasent-console: packages/guard",
    "status": "active",
    "edges": [
      {
        "to": "gate",
        "type": "realizes"
      },
      {
        "to": "runtime-authority",
        "type": "uses"
      },
      {
        "to": "permit",
        "type": "uses"
      }
    ]
  },
  {
    "id": "atlasent-cli",
    "name": "atlasent CLI",
    "kind": "product",
    "ref": "atlasent-console: packages/atlasent",
    "status": "active",
    "edges": [
      {
        "to": "runtime-authority",
        "type": "uses"
      }
    ]
  },
  {
    "id": "gxp-starter",
    "name": "GxP Starter Kit",
    "kind": "product",
    "ref": "atlasent-gxp-starter: TS lib + CLI + MCP server for 21 CFR Part 11 / GxP",
    "status": "active",
    "edges": [
      {
        "to": "gate",
        "type": "realizes"
      },
      {
        "to": "runtime-authority",
        "type": "uses"
      },
      {
        "to": "evidence",
        "type": "produces"
      }
    ]
  },
  {
    "id": "github-connector",
    "name": "GitHub connector",
    "kind": "connector",
    "ref": "atlasent-api: _shared/assertion-connectors.ts — deploy.status, PR approval (HMAC)",
    "status": "shipped",
    "edges": [
      {
        "to": "assertion",
        "type": "produces"
      }
    ]
  },
  {
    "id": "slack-connector",
    "name": "Slack connector",
    "kind": "connector",
    "ref": "atlasent-api: _shared/assertion-connectors.ts — approval.human (HMAC)",
    "status": "shipped",
    "edges": [
      {
        "to": "assertion",
        "type": "produces"
      }
    ]
  },
  {
    "id": "stripe-connector",
    "name": "Stripe connector",
    "kind": "connector",
    "ref": "atlasent-api: _shared/assertion-connectors.ts — HMAC-verified webhook",
    "status": "shipped",
    "edges": [
      {
        "to": "assertion",
        "type": "produces"
      }
    ]
  },
  {
    "id": "connector-framework",
    "name": "Connector framework",
    "kind": "connector",
    "ref": "atlasent-api: v1-connectors (registry, rotate/revoke, ConnectorManagement UI). Skeleton types (Jira/ServiceNow/…) are aspirational — not emitting.",
    "status": "shipped",
    "edges": [
      {
        "to": "assertion",
        "type": "produces"
      }
    ]
  },
  {
    "id": "governance-kits",
    "name": "Governance Kits (18)",
    "kind": "doc",
    "ref": "atlasent-docs: governance-kits/ (deploy-gate, close-governance, financial-close, vendor-payment-release, …)",
    "status": "active",
    "edges": [
      {
        "to": "consequential-action",
        "type": "explains"
      },
      {
        "to": "permit",
        "type": "explains"
      }
    ]
  }
];

export const ATLAS_EDGES: AtlasEdge[] = [
  {
    "from": "assertion",
    "to": "trusted-assertion",
    "type": "feeds"
  },
  {
    "from": "trust-root",
    "to": "trusted-assertion",
    "type": "feeds"
  },
  {
    "from": "caller",
    "to": "authority",
    "type": "feeds"
  },
  {
    "from": "trusted-assertion",
    "to": "authority",
    "type": "feeds"
  },
  {
    "from": "resource",
    "to": "authority",
    "type": "feeds"
  },
  {
    "from": "context",
    "to": "authority",
    "type": "feeds"
  },
  {
    "from": "authority",
    "to": "runtime-authority",
    "type": "feeds"
  },
  {
    "from": "consequential-action",
    "to": "runtime-authority",
    "type": "feeds"
  },
  {
    "from": "consequential-action",
    "to": "policy",
    "type": "feeds"
  },
  {
    "from": "runtime-authority",
    "to": "decision",
    "type": "feeds"
  },
  {
    "from": "policy",
    "to": "decision",
    "type": "feeds"
  },
  {
    "from": "decision",
    "to": "permit",
    "type": "feeds"
  },
  {
    "from": "permit",
    "to": "verification",
    "type": "feeds"
  },
  {
    "from": "evidence",
    "to": "verification",
    "type": "feeds"
  },
  {
    "from": "audit-chain",
    "to": "verification",
    "type": "feeds"
  },
  {
    "from": "decision",
    "to": "evidence",
    "type": "feeds"
  },
  {
    "from": "consequential-action",
    "to": "evidence",
    "type": "feeds"
  },
  {
    "from": "evidence",
    "to": "audit-chain",
    "type": "feeds"
  },
  {
    "from": "decision",
    "to": "gate",
    "type": "feeds"
  },
  {
    "from": "permit",
    "to": "gate",
    "type": "feeds"
  },
  {
    "from": "trusted-assertion",
    "to": "delegation",
    "type": "feeds"
  },
  {
    "from": "authority",
    "to": "delegation",
    "type": "feeds"
  },
  {
    "from": "deploy-gate",
    "to": "gate",
    "type": "realizes"
  },
  {
    "from": "deploy-gate",
    "to": "runtime-authority",
    "type": "uses"
  },
  {
    "from": "deploy-gate",
    "to": "permit",
    "type": "uses"
  },
  {
    "from": "deploy-gate",
    "to": "evidence",
    "type": "produces"
  },
  {
    "from": "enterprise-architecture",
    "to": "assertion",
    "type": "explains"
  },
  {
    "from": "enterprise-architecture",
    "to": "authority",
    "type": "explains"
  },
  {
    "from": "enterprise-architecture",
    "to": "permit",
    "type": "explains"
  },
  {
    "from": "enterprise-architecture",
    "to": "evidence",
    "type": "explains"
  },
  {
    "from": "executive-brief",
    "to": "consequential-action",
    "type": "explains"
  },
  {
    "from": "executive-brief",
    "to": "authority",
    "type": "explains"
  },
  {
    "from": "executive-brief",
    "to": "evidence",
    "type": "explains"
  },
  {
    "from": "ciso-guide",
    "to": "trusted-assertion",
    "type": "explains"
  },
  {
    "from": "ciso-guide",
    "to": "verification",
    "type": "explains"
  },
  {
    "from": "ciso-guide",
    "to": "evidence",
    "type": "explains"
  },
  {
    "from": "platform-guide",
    "to": "permit",
    "type": "explains"
  },
  {
    "from": "platform-guide",
    "to": "verification",
    "type": "explains"
  },
  {
    "from": "floqast-pilot",
    "to": "deploy-gate",
    "type": "uses"
  },
  {
    "from": "floqast-pilot",
    "to": "runtime-authority",
    "type": "relies_on"
  },
  {
    "from": "floqast-pilot",
    "to": "evidence",
    "type": "relies_on"
  },
  {
    "from": "mcp-server",
    "to": "gate",
    "type": "realizes"
  },
  {
    "from": "mcp-server",
    "to": "runtime-authority",
    "type": "uses"
  },
  {
    "from": "mcp-server",
    "to": "permit",
    "type": "uses"
  },
  {
    "from": "sdk",
    "to": "gate",
    "type": "realizes"
  },
  {
    "from": "sdk",
    "to": "runtime-authority",
    "type": "uses"
  },
  {
    "from": "sdk",
    "to": "permit",
    "type": "uses"
  },
  {
    "from": "sdk",
    "to": "verification",
    "type": "uses"
  },
  {
    "from": "llm-middleware",
    "to": "gate",
    "type": "realizes"
  },
  {
    "from": "llm-middleware",
    "to": "runtime-authority",
    "type": "uses"
  },
  {
    "from": "llm-middleware",
    "to": "permit",
    "type": "uses"
  },
  {
    "from": "evaluate-endpoint",
    "to": "runtime-authority",
    "type": "realizes"
  },
  {
    "from": "evaluate-endpoint",
    "to": "decision",
    "type": "realizes"
  },
  {
    "from": "verify-endpoints",
    "to": "verification",
    "type": "realizes"
  },
  {
    "from": "verify-endpoints",
    "to": "audit-chain",
    "type": "realizes"
  },
  {
    "from": "assertion-ingest",
    "to": "assertion",
    "type": "realizes"
  },
  {
    "from": "offline-verifier",
    "to": "audit-chain",
    "type": "realizes"
  },
  {
    "from": "offline-verifier",
    "to": "verification",
    "type": "realizes"
  },
  {
    "from": "offline-verifier",
    "to": "evidence",
    "type": "relies_on"
  },
  {
    "from": "audit-verify-cli",
    "to": "audit-chain",
    "type": "realizes"
  },
  {
    "from": "audit-verify-cli",
    "to": "verification",
    "type": "realizes"
  },
  {
    "from": "audit-verify-cli",
    "to": "evidence",
    "type": "relies_on"
  },
  {
    "from": "audit-export",
    "to": "evidence",
    "type": "produces"
  },
  {
    "from": "deploy-gate-action",
    "to": "deploy-gate",
    "type": "uses"
  },
  {
    "from": "guard-cli",
    "to": "gate",
    "type": "realizes"
  },
  {
    "from": "guard-cli",
    "to": "runtime-authority",
    "type": "uses"
  },
  {
    "from": "guard-cli",
    "to": "permit",
    "type": "uses"
  },
  {
    "from": "atlasent-cli",
    "to": "runtime-authority",
    "type": "uses"
  },
  {
    "from": "gxp-starter",
    "to": "gate",
    "type": "realizes"
  },
  {
    "from": "gxp-starter",
    "to": "runtime-authority",
    "type": "uses"
  },
  {
    "from": "gxp-starter",
    "to": "evidence",
    "type": "produces"
  },
  {
    "from": "github-connector",
    "to": "assertion",
    "type": "produces"
  },
  {
    "from": "slack-connector",
    "to": "assertion",
    "type": "produces"
  },
  {
    "from": "stripe-connector",
    "to": "assertion",
    "type": "produces"
  },
  {
    "from": "connector-framework",
    "to": "assertion",
    "type": "produces"
  },
  {
    "from": "governance-kits",
    "to": "consequential-action",
    "type": "explains"
  },
  {
    "from": "governance-kits",
    "to": "permit",
    "type": "explains"
  }
];
