// Hand-maintained retrieval vocabulary for `atlasent_lookup_action`'s
// natural-language query path (see actionRetrieval.ts).
//
// This file is deliberately NOT generated. `src/canonCatalog.ts` is a
// drift-gated mirror of `atlasent/generated/act-spec-index.json`
// (`.github/workflows/canon-mirror-drift.yml` fails on any diff), so alias
// text cannot live there. Everything here is *query-side* vocabulary that
// maps what an agent or operator might say onto tokens that already exist
// in the Canon's own slugs / display names / descriptions.
//
// Two invariants, both enforced by actionRetrieval.test.ts:
//
//   1. Every key of SLUG_ALIASES MUST be a slug present in CANON_ACT_CATALOG.
//      A slug that leaves the Canon (deprecation, rename) makes the test fail
//      loudly rather than leaving a dangling alias that could route a query
//      to an action that no longer exists.
//   2. Nothing in this file can *create* an action. The ranker only ever
//      returns slugs drawn from CANON_ACT_CATALOG; aliases only add match
//      surface to existing entries. Canon minting goes through the intake
//      pipeline (atlasent/contract/canonical-actions/LIFECYCLE.md) — never
//      through a client-side synonym.

/**
 * Single-token synonyms: a raw lowercase query token → the Canon vocabulary
 * token(s) it should also count as. Applied before stemming, on both sides
 * of nothing — only the query is expanded; the index is built from the
 * Canon text as-is.
 */
export const QUERY_TOKEN_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  // environments / targets
  prod: ["production"],
  prd: ["production"],
  live: ["production"],
  k8s: ["infrastructure", "cluster"],
  kubernetes: ["infrastructure", "cluster"],
  terraform: ["infrastructure", "change"],
  helm: ["infrastructure", "change"],
  iac: ["infrastructure", "change"],
  db: ["database"],
  postgres: ["database"],
  schema: ["database", "migration"],
  // deploy / release family
  ship: ["deploy", "release"],
  rollout: ["deploy"],
  push: ["deploy"],
  launch: ["deploy", "release"],
  cutover: ["deploy", "failover"],
  hotfix: ["deploy"],
  revert: ["rollback"],
  undo: ["rollback"],
  roll: ["rollback"],
  flag: ["feature"],
  toggle: ["feature", "enable"],
  // identity / access
  give: ["grant"],
  remove: ["revoke", "delete", "destroy"],
  offboard: ["revoke", "terminate"],
  onboard: ["grant"],
  admin: ["privileged"],
  sudo: ["privileged"],
  root: ["privileged"],
  breakglass: ["breakglass", "break", "glass"],
  // secrets
  credential: ["secret"],
  credentials: ["secret"],
  creds: ["secret"],
  password: ["secret"],
  token: ["secret"],
  apikey: ["secret"],
  // data
  download: ["export"],
  extract: ["export"],
  upload: ["import"],
  ingest: ["import"],
  purge: ["delete"],
  wipe: ["delete"],
  drop: ["delete", "destroy"],
  teardown: ["destroy"],
  decommission: ["destroy", "suspend"],
  // finance
  pay: ["payment"],
  payout: ["payment"],
  invoice: ["payment"],
  ach: ["wire", "transfer"],
  swift: ["wire", "transfer"],
  ledger: ["journal"],
  books: ["period", "close", "journal"],
  gl: ["journal"],
  reconcile: ["reconciliation"],
  // people
  fire: ["terminate"],
  layoff: ["terminate"],
  dismiss: ["terminate"],
  salary: ["compensation"],
  raise: ["compensation"],
  bonus: ["compensation"],
  // clinical
  unblind: ["unblinding"],
  blind: ["blinding"],
  randomisation: ["randomization"],
  // industrial
  plc: ["industrial", "controller"],
  scada: ["industrial", "control"],
  actuator: ["actuate"],
  valve: ["actuate"],
  // agents / models
  llm: ["agent", "model"],
  ai: ["agent", "model"],
  bot: ["agent"],
  // ops
  quarantine: ["isolate"],
  contain: ["isolate"],
  pause: ["suspend"],
  stop: ["suspend"],
  restart: ["resume"],
  resume: ["resume"],
  failover: ["failover"],
  dr: ["failover"],
  attest: ["certify"],
  signoff: ["approve", "certify"],
  // communications
  email: ["communication", "send", "external"],
  newsletter: ["communication", "send", "external"],
  press: ["publish", "content"],
  blog: ["publish", "content"],
};

/**
 * Multi-word phrases matched against the raw lowercase query. When a phrase
 * occurs, its expansion tokens are appended to the query. Longest phrases
 * are tried first so "close the books" wins over "close".
 */
export const QUERY_PHRASES: ReadonlyArray<readonly [phrase: string, expansion: readonly string[]]> = [
  ["close the books", ["period", "close", "accounting"]],
  ["month end close", ["period", "close", "accounting"]],
  ["month-end close", ["period", "close", "accounting"]],
  ["quarter end", ["period", "close", "accounting"]],
  ["year end", ["period", "close", "accounting"]],
  ["break glass", ["breakglass", "security"]],
  ["break-glass", ["breakglass", "security"]],
  ["emergency access", ["breakglass", "security", "access"]],
  ["feature flag", ["feature", "enable"]],
  ["kill switch", ["feature", "enable"]],
  ["wire transfer", ["wire", "transfer", "payment"]],
  ["journal entry", ["journal", "entry"]],
  ["tool call", ["agent", "tool", "invoke"]],
  ["function call", ["agent", "tool", "invoke"]],
  ["roll back", ["rollback"]],
  ["roll forward", ["deploy"]],
  ["safety system", ["industrial", "safety", "bypass"]],
  ["safety interlock", ["industrial", "safety", "bypass"]],
  ["health record", ["healthcare", "record", "amend"]],
  ["medical record", ["healthcare", "record", "amend"]],
  ["patient record", ["healthcare", "record", "amend"]],
  ["genomic data", ["genomic", "data"]],
  ["cross border", ["genomic", "export"]],
  ["cross-border", ["genomic", "export"]],
];

/**
 * Per-slug alias phrases: extra text indexed against a specific Canon entry
 * at a high field weight. Keys MUST be live Canon slugs (tested).
 */
export const SLUG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "production.deploy": [
    "deploy to production",
    "deploy service to prod",
    "ship a release to production",
    "run a deployment",
    "apply a change plan",
    "ci cd pipeline deploy",
  ],
  "production.rollback": ["roll back a deployment", "revert production", "undo a deploy"],
  "artifact.release": ["publish a build artifact", "push a container image", "publish package to registry", "helm chart release"],
  "release.create": ["cut a release", "tag a release", "create release"],
  "feature.enable": ["turn on a feature flag", "enable feature", "flip a toggle"],
  "workflow.approve": ["approve a workflow", "approve a change request"],
  "workflow.escalate": ["escalate a workflow", "escalate for approval"],
  "infrastructure.change": ["apply terraform", "helm upgrade", "change cloud infrastructure", "modify kubernetes cluster"],
  "database.migrate": ["run a database migration", "alter schema", "migrate the database"],
  "resource.create": ["provision a cloud resource", "create a server", "spin up infrastructure"],
  "resource.destroy": ["tear down a resource", "delete a server", "destroy infrastructure"],
  "service.suspend": ["pause a service", "take a service offline", "disable a service"],
  "service.resume": ["restart a service", "bring a service back online", "re-enable a service"],
  "traffic.failover": ["fail over traffic", "switch region", "disaster recovery cutover"],
  "host.isolate": ["quarantine a host", "isolate a machine", "contain a compromised host"],
  "secret.rotate": ["rotate a secret", "rotate credentials", "rotate an api key", "rotate signing key"],
  "secret.configuration.change": ["change a secret configuration", "edit secret settings", "reconfigure vault"],
  "access.grant": ["give a user access", "grant permission", "add someone to a group"],
  "access.revoke": ["remove a user's access", "revoke permission", "offboard access"],
  "identity.privileged.grant": ["grant admin", "grant root", "elevate privileges", "make someone an administrator"],
  "identity.sign": ["sign as an identity", "electronic signature", "e-signature"],
  "security.breakglass": ["break glass", "emergency access", "override security to get in"],
  "control.override": ["override a control", "bypass a control", "manual override"],
  "data.export": ["export customer data", "bulk export", "download a dataset", "dump the database"],
  "data.import": ["import data", "bulk load", "ingest a file"],
  "data.modify": ["edit records", "update production data", "modify data"],
  "data.delete": ["delete records", "purge data", "erase customer data"],
  "genomic.data.release": ["release identifiable genomic data", "share genome data"],
  "genomic.data.export": ["export genomic data across borders", "cross border genomic transfer"],
  "communication.external.send": ["send an external email", "send a customer communication", "send a newsletter"],
  "content.publish": ["publish content", "publish a blog post", "publish a press release", "go live with content"],
  "compliance.certify": ["certify compliance", "attest a control", "sign off compliance"],
  "finance.payment.authorize": ["authorize a payment", "approve a large payment", "pay an invoice"],
  "finance.wire.transfer": ["send a wire", "wire money", "high value transfer"],
  "journal.post": ["post a journal entry", "post to the general ledger"],
  "journal_entry.approve": ["approve a journal entry", "approve a manual journal"],
  "period.close": ["close the books", "close the accounting period", "month end close"],
  "reconciliation.certify": ["certify a reconciliation", "sign off a reconciliation"],
  "variance_review.escalate": ["escalate a variance", "flag a variance for review"],
  "employment.terminate": ["terminate an employee", "fire someone", "offboard an employee"],
  "compensation.change": ["change salary", "give a raise", "adjust compensation"],
  "trial.unblinding.execute": ["unblind a trial", "unblind the study"],
  "trial.unblinding.emergency": ["emergency unblinding", "unblind for a medical emergency"],
  "trial.blinding.setup": ["set up blinding", "establish the blind"],
  "trial.randomization.break": ["break the randomization code", "reveal treatment allocation"],
  "trial.biomarker.reclassify": ["reclassify a biomarker result"],
  "trial.biomarker.eligibility.override": ["override biomarker eligibility"],
  "protocol.amend": ["amend a clinical protocol", "protocol amendment"],
  "healthcare.record.amend": ["amend a patient record", "edit a medical record"],
  "industrial.control.actuate": ["actuate an industrial control", "open a valve", "command a plc"],
  "industrial.controller.configure": ["reconfigure a plc", "change controller settings"],
  "industrial.safety.bypass": ["bypass a safety system", "bypass an interlock", "defeat a safety instrumented system"],
  "agent.tool.invoke": ["let an agent call a tool", "agent tool call", "llm function call"],
  "model.promote": ["promote a model", "ship a model to production", "deploy a model"],
};

/**
 * Query tokens that describe *context* around an action, not the action.
 * Per LIFECYCLE.md's classification principle, context (emergency, regulated,
 * weekend, maintenance window, …) lives in policy / permits / evidence, never
 * in a canon_id — so these must not pull a query toward a different action
 * or make a real action look unmatched. They are down-weighted, not dropped,
 * because a few Canon entries legitimately carry them in their own slug
 * (e.g. `trial.unblinding.emergency`).
 */
export const CONTEXT_MODIFIER_TOKENS: ReadonlySet<string> = new Set([
  "emergency",
  "urgent",
  "urgently",
  "asap",
  "immediately",
  "weekend",
  "overnight",
  "tonight",
  "today",
  "now",
  "regulated",
  "maintenance",
  "window",
  "scheduled",
  "planned",
  "unplanned",
  "quick",
  "quickly",
  "manual",
  "manually",
  "automated",
  "critical",
  "high",
  "low",
  "risk",
  "risky",
]);

/** Plain English filler that carries no action signal. Dropped outright. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "to", "of", "for", "on", "in", "at", "by", "with", "and", "or",
  "i", "we", "you", "me", "my", "our", "your", "it", "its", "this", "that", "these", "those",
  "is", "are", "be", "been", "am", "was", "were", "do", "does", "did", "can", "could",
  "want", "wants", "need", "needs", "would", "like", "please", "help", "let", "lets",
  "go", "make", "get", "have", "has", "just", "about", "into", "onto", "from", "as",
  "some", "any", "all", "how", "what", "which", "who", "when", "where", "so", "then",
  "should", "must", "will", "shall", "may", "might", "ok", "okay",
  // qualifiers that carry no action signal and would otherwise count as
  // "known" vocabulary (they appear incidentally in Canon descriptions)
  "new", "brand", "old", "existing", "current", "latest", "last", "next", "previous",
  "another", "other", "one", "two", "first", "second", "same", "own", "every", "each",
]);
