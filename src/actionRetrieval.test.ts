import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CANON_ACT_CATALOG } from "./canonCatalog.js";
import { buildIndex, queryTokens, rankActions, stem } from "./actionRetrieval.js";
import { SLUG_ALIASES } from "./actionSynonyms.js";

const CANON_SLUGS = new Set(CANON_ACT_CATALOG.map((a) => a.slug));

describe("actionRetrieval — vocabulary invariants", () => {
  it("every SLUG_ALIASES key is a live Canon slug (alias drift guard)", () => {
    const dangling = Object.keys(SLUG_ALIASES).filter((slug) => !CANON_SLUGS.has(slug));
    assert.deepEqual(
      dangling,
      [],
      `aliases reference slugs that are not in the vendored Canon: ${dangling.join(", ")} — ` +
        "remove or re-key them; an alias must never route to an action that no longer exists",
    );
  });

  it("every candidate the ranker can return is a Canon entry by reference", () => {
    const index = buildIndex();
    for (const doc of index.docs) {
      assert.ok(CANON_SLUGS.has(doc.entry.slug));
      assert.match(doc.entry.canon_id, /^CANON-\d{6}$/);
    }
    assert.equal(index.docs.length, CANON_ACT_CATALOG.length);
  });

  it("the stemmer is symmetric across common inflections", () => {
    assert.equal(stem("deployment"), stem("deploy"));
    assert.equal(stem("deploying"), stem("deployed"));
    assert.equal(stem("migration"), stem("migrate"));
    assert.equal(stem("termination"), stem("terminate"));
    assert.equal(stem("unblinding"), stem("unblind"));
  });

  it("query expansion applies phrases and synonyms and drops stopwords", () => {
    const { terms } = queryTokens("please close the books for month end");
    assert.ok(terms.includes(stem("period")), `expected period, got ${terms.join(",")}`);
    assert.ok(terms.includes(stem("close")));
    assert.ok(!terms.includes("the"));
    assert.ok(!terms.includes("please"));

    const prod = queryTokens("ship it to prod");
    assert.ok(prod.terms.includes(stem("production")), "prod → production");
    assert.ok(prod.terms.includes(stem("deploy")), "ship → deploy");
  });
});

describe("actionRetrieval — ranking", () => {
  const confident = (query: string, expectedSlug: string) => {
    const r = rankActions(query);
    assert.equal(r.confidence, "confident", `${JSON.stringify(query)} → ${JSON.stringify(r)}`);
    assert.equal(r.candidates[0]?.slug, expectedSlug, `${JSON.stringify(query)} → ${JSON.stringify(r.candidates)}`);
  };

  it("resolves the motivating query to production.deploy", () => {
    confident("deploy the api service to prod", "production.deploy");
  });

  it("resolves a spread of plain-English requests to the right Canon entry", () => {
    confident("grant admin privileges to an engineer", "identity.privileged.grant");
    confident("give a user access to the repo", "access.grant");
    confident("rotate the database password", "secret.rotate");
    confident("export all customer data as a csv", "data.export");
    confident("close the books for the month", "period.close");
    confident("unblind the study for a patient", "trial.unblinding.execute");
    confident("send a wire transfer", "finance.wire.transfer");
    confident("roll back the last deployment", "production.rollback");
    confident("terminate an employee", "employment.terminate");
    confident("apply terraform to the cluster", "infrastructure.change");
    confident("bypass the safety interlock on the line", "industrial.safety.bypass");
  });

  it("treats context modifiers as context, not as a different action (LIFECYCLE.md)", () => {
    // "emergency deploy" is still production.deploy — emergency is policy context,
    // never a reason to look for (or invent) an emergency.deploy action.
    const r = rankActions("emergency deploy to production this weekend");
    assert.equal(r.candidates[0]?.slug, "production.deploy", JSON.stringify(r));
    assert.equal(r.confidence, "confident");
    // Coverage ignores the modifiers, so they do not drag confidence down.
    assert.equal(r.coverage, 1);
  });

  it("returns confidence none and no candidates for text with no Canon vocabulary", () => {
    const r = rankActions("make me a sandwich with extra pickles");
    assert.equal(r.confidence, "none");
    assert.deepEqual(r.candidates, []);
    assert.ok(r.unknown_terms.length > 0);
  });

  it("returns confidence none when the only overlap is incidental", () => {
    // "record" appears in several descriptions; a query of unrelated words
    // with one incidental hit must not be reported as a match.
    const r = rankActions("record my favourite song lyrics on the guitar");
    assert.notEqual(r.confidence, "confident", JSON.stringify(r));
  });

  it("reports a genuinely two-way request as ambiguous, with both readings in the top two", () => {
    // "grant admin access to a user" is honestly between the plain and the
    // privileged grant; the ranker must surface both and not pick one as confident.
    const r = rankActions("grant admin access to a user");
    assert.notEqual(r.confidence, "none");
    const top2 = r.candidates.slice(0, 2).map((c) => c.slug).sort();
    assert.deepEqual(top2, ["access.grant", "identity.privileged.grant"], JSON.stringify(r));
  });

  it("reports ambiguity instead of guessing between near-equal candidates", () => {
    // 'data' alone is shared across the whole data.* family.
    const r = rankActions("data");
    assert.notEqual(r.confidence, "confident", JSON.stringify(r));
    assert.ok(r.candidates.length >= 2);
    assert.ok(r.margin_ratio > 0.8, `expected a near tie, got margin_ratio=${r.margin_ratio}`);
  });

  it("is deterministic: same query, same ranking, stable tiebreak", () => {
    const a = rankActions("suspend the service");
    const b = rankActions("suspend the service");
    assert.deepEqual(a, b);
    assert.equal(a.candidates[0]?.slug, "service.suspend");
  });

  it("honors the limit and never exceeds the catalog size", () => {
    assert.equal(rankActions("deploy", { limit: 3 }).candidates.length, 3);
    assert.ok(rankActions("deploy", { limit: 10_000 }).candidates.length <= CANON_ACT_CATALOG.length);
  });

  it("never returns a slug outside the Canon, for any input", () => {
    const probes = [
      "emergency.deploy",
      "tenant.provision",
      "release.approve",
      "delete everything",
      "",
      "   ",
      "!!!???",
      "x".repeat(300),
    ];
    for (const q of probes) {
      for (const c of rankActions(q).candidates) {
        assert.ok(CANON_SLUGS.has(c.slug), `${q} produced non-Canon slug ${c.slug}`);
      }
    }
  });

  it("rebuilds against a stub catalog when asked (index injection)", () => {
    const stub = buildIndex([
      {
        ...CANON_ACT_CATALOG[0],
        slug: "widget.frobnicate",
        canon_id: "CANON-999999",
        display_name: "Frobnicate Widget",
        description: "frobnicate a widget",
        family: "widget.ops",
      },
    ]);
    const r = rankActions("frobnicate the widget", { index: stub });
    assert.equal(r.confidence, "confident");
    assert.equal(r.candidates[0]?.slug, "widget.frobnicate");
  });
});
