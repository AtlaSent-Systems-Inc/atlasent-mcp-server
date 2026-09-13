// Offline natural-language → canonical-action retrieval for
// `atlasent_lookup_action`.
//
// Design constraints (all load-bearing — see the design record in
// atlasent-docs / the PR that introduced this module):
//
//   * Fully offline and deterministic. No embeddings service, no network,
//     no randomness. The same query against the same vendored Canon always
//     yields the same ranking, so a test can pin it and an operator can
//     reproduce it.
//   * Never invents an action. Every candidate returned is an entry of
//     CANON_ACT_CATALOG, by reference. There is no code path that
//     synthesizes a slug or a canon_id — minting is the intake pipeline's
//     job (atlasent/contract/canonical-actions/LIFECYCLE.md).
//   * Says "no confident match" explicitly. A low-scoring or ambiguous top
//     result is reported as such rather than returned as if it were right.
//     An agent that wants to *act* on the answer should only trust
//     `confidence === "confident"`.
//   * Index built eagerly from the vendored catalog at first use — 54-ish
//     documents, a few milliseconds. No caching layer, no lazy I/O.
//
// Ranking model: field-weighted BM25 over a light stemmer, with a
// hand-maintained query-side synonym / phrase / alias vocabulary
// (actionSynonyms.ts). Slug and alias tokens dominate; the long, boilerplate
// `description` text is indexed at a low weight because nearly every Canon
// entry shares vocabulary like "authorization gate", "tamper-evident
// permit", "audit chain" — BM25's IDF suppresses most of it, the low weight
// handles the rest.

import { CANON_ACT_CATALOG, type ActSpecEntry } from "./canonCatalog.js";
import { CANON_ACTION_GRAPH } from "./canonGraph.js";
import {
  CONTEXT_MODIFIER_TOKENS,
  QUERY_PHRASES,
  QUERY_TOKEN_SYNONYMS,
  SLUG_ALIASES,
  STOPWORDS,
} from "./actionSynonyms.js";

export type RetrievalConfidence = "confident" | "ambiguous" | "none";

export interface RetrievalCandidate {
  slug: string;
  canon_id: string;
  display_name: string;
  /** BM25 score, rounded to 3 decimals for stable output. */
  score: number;
  /** Query terms (post-normalization) that matched this entry. */
  matched_terms: string[];
}

export interface RetrievalResult {
  mode: "ranked";
  confidence: RetrievalConfidence;
  /** Normalized query terms actually used for ranking (stopwords removed). */
  query_terms: string[];
  /** Query terms that occur nowhere in the Canon vocabulary. */
  unknown_terms: string[];
  /** Fraction (0..1) of known query terms that the top candidate matched. */
  coverage: number;
  /** second.score / top.score — 1.0 means a dead heat, 0 means no runner-up. */
  margin_ratio: number;
  candidates: RetrievalCandidate[];
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Suffix rewrites, tried longest-first. A rewrite maps a nominal form back
 * onto its verb form *before* the trailing-e strip, so "migration" →
 * "migrate" → "migrat" agrees with "migrate" → "migrat".
 */
const SUFFIX_REWRITES: ReadonlyArray<readonly [suffix: string, replacement: string]> = [
  ["izations", "ize"],
  ["ization", "ize"],
  ["urations", "ure"],
  ["uration", "ure"],
  ["ations", "ate"],
  ["ation", "ate"],
  ["ments", ""],
  ["ment", ""],
  ["ings", ""],
  ["ing", ""],
  ["ions", ""],
  ["ion", ""],
  ["ies", "y"],
  ["ed", ""],
  ["es", ""],
  ["s", ""],
];

/**
 * Light, symmetric stemmer. Not Porter — just enough that "deployment",
 * "deploying", "deployed" and "deploy" agree, applied identically on the
 * index and the query so any over-stemming is at least consistent.
 */
export function stem(token: string): string {
  let t = token;
  if (t.length <= 3) return t;
  for (const [suffix, replacement] of SUFFIX_REWRITES) {
    if (t.endsWith(suffix) && t.length - suffix.length >= 3) {
      t = t.slice(0, -suffix.length) + replacement;
      break;
    }
  }
  if (t.length > 4 && t.endsWith("e")) t = t.slice(0, -1);
  return t;
}

function rawTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Tokenize Canon-side text: split, drop stopwords, stem. No synonym expansion. */
export function indexTokens(text: string): string[] {
  return rawTokens(text)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
}

/**
 * Tokenize a user query: phrase expansion on the raw string, then per-token
 * synonym expansion, stopword removal, stemming. Returns the stemmed terms
 * plus which of them arrived as context modifiers (down-weighted at scoring).
 */
export function queryTokens(query: string): { terms: string[]; contextTerms: Set<string> } {
  const lower = query.toLowerCase();
  const expansions: string[] = [];
  // Longest phrases first so a more specific phrase wins over a prefix of it.
  const phrases = [...QUERY_PHRASES].sort((a, b) => b[0].length - a[0].length);
  for (const [phrase, expansion] of phrases) {
    if (lower.includes(phrase)) expansions.push(...expansion);
  }

  const contextTerms = new Set<string>();
  const out: string[] = [];
  for (const raw of [...rawTokens(lower), ...expansions]) {
    if (STOPWORDS.has(raw)) continue;
    const isContext = CONTEXT_MODIFIER_TOKENS.has(raw);
    const expanded = [raw, ...(QUERY_TOKEN_SYNONYMS[raw] ?? [])];
    for (const e of expanded) {
      const s = stem(e);
      out.push(s);
      if (isContext) contextTerms.add(s);
    }
  }
  // Dedupe while preserving first-seen order (order only affects output).
  const seen = new Set<string>();
  const terms = out.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
  return { terms, contextTerms };
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

interface IndexedDoc {
  entry: ActSpecEntry;
  /** term → weighted term frequency */
  tf: Map<string, number>;
  /** sum of weighted tf, used for length normalization */
  length: number;
  /** stemmed tokens of the slug itself, e.g. production.rollback → {product, rollback} */
  slugTerms: Set<string>;
}

interface Index {
  docs: IndexedDoc[];
  /** term → number of docs containing it */
  df: Map<string, number>;
  avgLength: number;
  vocabulary: Set<string>;
}

/**
 * Field weights. Slug and alias tokens are the strongest signal a Canon
 * entry has about *what it is*; description is the weakest because it is
 * long and shares vocabulary across most entries.
 */
const FIELD_WEIGHTS = {
  slug: 6,
  alias: 5,
  display_name: 4,
  family: 2,
  domain: 2,
  use_case: 1.5,
  controls: 0.75,
  description: 0.5,
  // `industries` is deliberately NOT indexed: "saas", "fintech", "enterprise"
  // are audience tags, not action semantics. Indexing them let "provision a
  // saas tenant" reach a confident resource.create on the strength of the
  // word "saas" — an action the Canon does not actually have.
} as const;

/**
 * BM25 saturation. Textbook k1 (1.2) is tuned for raw term counts in prose;
 * here tf carries *field weights* (a slug hit is 6, a description hit 0.5),
 * and at k1=1.2 a weighted tf of 6 and of 13 saturate to nearly the same
 * value, erasing the field weighting. A higher k1 keeps the weights
 * meaningful. Tuned empirically against the queries in
 * actionRetrieval.test.ts; change together with that suite.
 */
let BM25_K1 = 6;
let BM25_B = 0.5;
/** Context-modifier terms contribute a quarter of their normal IDF weight. */
const CONTEXT_TERM_WEIGHT = 0.25;

/** Test/tuning hook: override BM25 parameters. Returns the previous values. */
export function _configureRankerForTests(params: { k1?: number; b?: number }): { k1: number; b: number } {
  const prev = { k1: BM25_K1, b: BM25_B };
  if (params.k1 !== undefined) BM25_K1 = params.k1;
  if (params.b !== undefined) BM25_B = params.b;
  return prev;
}

let cachedIndex: Index | undefined;

function addTokens(tf: Map<string, number>, tokens: string[], weight: number): number {
  let added = 0;
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + weight);
    added += weight;
  }
  return added;
}

export function buildIndex(catalog: readonly ActSpecEntry[] = CANON_ACT_CATALOG): Index {
  const docs: IndexedDoc[] = [];
  const df = new Map<string, number>();
  const vocabulary = new Set<string>();
  let totalLength = 0;

  for (const entry of catalog) {
    const tf = new Map<string, number>();
    let length = 0;
    // slug: "trial.unblinding.emergency" → trial, unblinding, emergency
    const slugTokens = indexTokens(entry.slug.replace(/[._]/g, " "));
    length += addTokens(tf, slugTokens, FIELD_WEIGHTS.slug);
    length += addTokens(tf, indexTokens(entry.display_name), FIELD_WEIGHTS.display_name);
    length += addTokens(tf, indexTokens(entry.family.replace(/[._]/g, " ")), FIELD_WEIGHTS.family);
    const neighborhood = CANON_ACTION_GRAPH[entry.slug];
    if (neighborhood?.domain) {
      length += addTokens(tf, indexTokens(neighborhood.domain), FIELD_WEIGHTS.domain);
    }
    if (neighborhood?.controls?.length) {
      length += addTokens(tf, indexTokens(neighborhood.controls.join(" ")), FIELD_WEIGHTS.controls);
    }
    length += addTokens(tf, indexTokens(entry.use_case ?? ""), FIELD_WEIGHTS.use_case);
    length += addTokens(tf, indexTokens(entry.description ?? ""), FIELD_WEIGHTS.description);
    for (const alias of SLUG_ALIASES[entry.slug] ?? []) {
      length += addTokens(tf, indexTokens(alias), FIELD_WEIGHTS.alias);
    }

    for (const term of tf.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
      vocabulary.add(term);
    }
    docs.push({ entry, tf, length, slugTerms: new Set(slugTokens) });
    totalLength += length;
  }

  return {
    docs,
    df,
    avgLength: docs.length > 0 ? totalLength / docs.length : 1,
    vocabulary,
  };
}

function getIndex(): Index {
  if (!cachedIndex) cachedIndex = buildIndex();
  return cachedIndex;
}

/** Test hook: drop the memoized index so a test can rebuild against a stub catalog. */
export function _resetIndexForTests(): void {
  cachedIndex = undefined;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function idf(index: Index, term: string): number {
  const n = index.docs.length;
  const d = index.df.get(term) ?? 0;
  // Standard BM25 IDF with the +1 floor so a term present in every doc still
  // contributes a small positive amount rather than going negative.
  return Math.log(1 + (n - d + 0.5) / (d + 0.5));
}

export interface RankOptions {
  /** Maximum candidates to return. Default 5. */
  limit?: number;
  /** Test hook: rank against a specific index instead of the memoized one. */
  index?: Index;
}

/**
 * Confidence thresholds. These are deliberately simple and documented so a
 * reader can predict the verdict from the numbers in the result:
 *   - "none":      no candidate scored, or the top candidate matched fewer
 *                  than a third of the query's known terms.
 *   - "ambiguous": the runner-up is within 20% of the top score, or the top
 *                  candidate matched under half of the known terms.
 *   - "confident": otherwise.
 */
const MIN_COVERAGE_FOR_ANY_MATCH = 1 / 3;
const MIN_COVERAGE_FOR_CONFIDENT = 0.5;
const MAX_MARGIN_RATIO_FOR_CONFIDENT = 0.8;
/**
 * Known-term gate. If most of the query's substantive words occur nowhere in
 * the Canon vocabulary, one incidental hit ("record" in "record my song
 * lyrics") must not read as a match: below a third known → none; below half
 * known → at most ambiguous.
 */
const MIN_KNOWN_RATIO_FOR_ANY_MATCH = 1 / 3;
const MIN_KNOWN_RATIO_FOR_CONFIDENT = 0.5;
/**
 * Slug-coverage multiplier. A candidate whose own slug tokens are only partly
 * present in the query (production.rollback for "deploy to production") is
 * scaled down: score × (0.5 + 0.5 × matchedSlugTokens / slugTokens). This is
 * what separates "the action named by the query" from "an action that merely
 * shares the query's vocabulary in its aliases or description".
 */
const SLUG_COVERAGE_FLOOR = 0.5;

export function rankActions(query: string, options: RankOptions = {}): RetrievalResult {
  const index = options.index ?? getIndex();
  const limit = Math.max(1, Math.min(options.limit ?? 5, index.docs.length));
  const { terms, contextTerms } = queryTokens(query);

  const knownTerms = terms.filter((t) => index.vocabulary.has(t));
  const unknownTerms = terms.filter((t) => !index.vocabulary.has(t));

  const empty: RetrievalResult = {
    mode: "ranked",
    confidence: "none",
    query_terms: terms,
    unknown_terms: unknownTerms,
    coverage: 0,
    margin_ratio: 0,
    candidates: [],
  };
  if (knownTerms.length === 0) return empty;

  const scored = index.docs
    .map((doc) => {
      let score = 0;
      const matched: string[] = [];
      for (const term of knownTerms) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        const weight = contextTerms.has(term) ? CONTEXT_TERM_WEIGHT : 1;
        const norm = 1 - BM25_B + BM25_B * (doc.length / index.avgLength);
        const sat = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm);
        score += weight * idf(index, term) * sat;
        matched.push(term);
      }
      if (score > 0 && doc.slugTerms.size > 0) {
        let slugHits = 0;
        for (const t of doc.slugTerms) if (matched.includes(t)) slugHits++;
        score *= SLUG_COVERAGE_FLOOR + (1 - SLUG_COVERAGE_FLOOR) * (slugHits / doc.slugTerms.size);
      }
      return { doc, score, matched };
    })
    .filter((s) => s.score > 0)
    // Deterministic order: score desc, then slug asc as the tiebreak.
    .sort((a, b) => b.score - a.score || a.doc.entry.slug.localeCompare(b.doc.entry.slug));

  if (scored.length === 0) return empty;

  const top = scored[0];
  const second = scored[1];
  // Coverage counts non-context known terms; context modifiers neither help
  // nor hurt whether the action itself was recognized.
  const substantiveKnown = knownTerms.filter((t) => !contextTerms.has(t));
  const coverageDenominator = substantiveKnown.length > 0 ? substantiveKnown : knownTerms;
  const topMatchedSubstantive = top.matched.filter((t) => coverageDenominator.includes(t));
  const coverage = topMatchedSubstantive.length / coverageDenominator.length;
  const marginRatio = second ? second.score / top.score : 0;
  const substantiveAll = terms.filter((t) => !contextTerms.has(t));
  const knownRatio =
    substantiveAll.length > 0
      ? substantiveAll.filter((t) => index.vocabulary.has(t)).length / substantiveAll.length
      : 1;

  let confidence: RetrievalConfidence;
  if (coverage < MIN_COVERAGE_FOR_ANY_MATCH || knownRatio < MIN_KNOWN_RATIO_FOR_ANY_MATCH) {
    confidence = "none";
  } else if (
    coverage < MIN_COVERAGE_FOR_CONFIDENT ||
    knownRatio < MIN_KNOWN_RATIO_FOR_CONFIDENT ||
    marginRatio > MAX_MARGIN_RATIO_FOR_CONFIDENT
  ) {
    confidence = "ambiguous";
  } else confidence = "confident";

  return {
    mode: "ranked",
    confidence,
    query_terms: terms,
    unknown_terms: unknownTerms,
    coverage: round3(coverage),
    margin_ratio: round3(marginRatio),
    candidates: scored.slice(0, limit).map(({ doc, score, matched }) => ({
      slug: doc.entry.slug,
      canon_id: doc.entry.canon_id,
      display_name: doc.entry.display_name,
      score: round3(score),
      matched_terms: matched,
    })),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * The hint returned when nothing in the Canon matches. Points at the intake
 * pipeline rather than inviting the caller to make up an action type.
 */
export const NO_MATCH_HINT =
  "No canonical action in the vendored Canon matches this description. Do not invent an action_type: " +
  "governed actions are minted only through the Canon intake pipeline " +
  "(atlasent/contract/canonical-actions/LIFECYCLE.md — file a candidate in CANDIDATES.json). " +
  "Try rephrasing with the system and verb involved (e.g. 'deploy service to production', " +
  "'grant admin access', 'export customer data'), or omit all parameters to list the full Canon.";
