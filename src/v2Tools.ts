/**
 * V2 Wave B MCP tools — wraps the three Wave A endpoints landed in
 * atlasent-api #742 / #745 / #746.
 *
 *   atlasent_evaluate_many   → POST /v1/evaluate/batch   (v2_batch flag)
 *   atlasent_evaluate_stream → POST /v1/evaluate/stream  (v2_streaming flag)
 *   atlasent_query           → POST /v1/graphql          (v2_graphql flag)
 *
 * Closed-by-default discipline: every endpoint 404s when the tenant flag
 * is off. The HTTP client surfaces that as `FeatureNotEnabledError`; the
 * tool maps it to a typed MCP error result so the agent can decide whether
 * to fall back. There is no silent fallback at the MCP layer.
 *
 * --- Behavior-aware gates (deferred) ---------------------------------------
 * TODO(v2-wave-b/c): Behavior Conditioning Layer hook goes here. When
 * `@atlasent/behavior` (atlasent-sdk B.SDK9) lands and the
 * `v2_behavior_conditioning` flag is on, this registry should:
 *   1. read context.user_id from each item, fetch the redacted StateEvent
 *      summary, and attach `context.user_state` + `context.bvsSnapshot`;
 *   2. route a returned `decision: "escalate"` to a distinct MCP error
 *      class so the host can surface it to a human reviewer.
 * Tracked in V2_ROLLOUT.md as C.MCP1; out of scope for this PR because the
 * upstream package is not yet built.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolResult } from "./decision.js";
import {
  evaluateBatch,
  evaluateStream,
  graphqlQuery,
  FeatureNotEnabledError,
  type BatchEvaluateItem,
} from "./v2Client.js";

const MAX_FIELD_LEN = 256;
const MAX_BATCH_ITEMS = 100;
const MAX_GRAPHQL_QUERY_LEN = 100_000;

const batchItemSchema = z.object({
  action: z.string().min(1).max(MAX_FIELD_LEN),
  agent: z.string().min(1).max(MAX_FIELD_LEN),
  context: z.record(z.string(), z.unknown()).optional(),
});

const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "batch_id must be a UUID",
  );

function featureNotEnabledResult(e: FeatureNotEnabledError) {
  return toolResult({
    error: "feature_not_enabled",
    flag: e.flag,
    message: e.message,
  });
}

function toolError(e: unknown) {
  return toolResult({
    error: e instanceof Error ? e.message : String(e),
  });
}

/**
 * Register the three Wave B v2 tools onto an existing McpServer.
 *
 * Called from createServer() in src/server.ts. Lives in its own module
 * to keep the v1 tool surface (server.ts) untouched aside from a single
 * `registerV2Tools(server)` call.
 */
export function registerV2Tools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // atlasent_evaluate_many — POST /v1/evaluate/batch
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_evaluate_many",
    {
      title: "AtlaSent — Evaluate Many (batch)",
      description:
        "Evaluate up to 100 actions in a single request against your published " +
        "AtlaSent policies. Returns decisions in input order. Optional batch_id " +
        "(UUID) provides idempotency. Closed-by-default: 404 surfaces as a " +
        "`feature_not_enabled` error tagged with the `v2_batch` tenant flag.",
      inputSchema: z.object({
        items: z
          .array(batchItemSchema)
          .min(1)
          .max(MAX_BATCH_ITEMS)
          .describe("Items to evaluate (1-100). Decisions returned in input order."),
        batch_id: uuid.optional().describe("Optional UUID for idempotency."),
      }),
      annotations: {
        title: "AtlaSent — Evaluate Many",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const items: BatchEvaluateItem[] = args.items.map((it) => ({
          action: it.action,
          agent: it.agent,
          ...(it.context !== undefined ? { context: it.context } : {}),
        }));
        const result = await evaluateBatch({
          items,
          ...(args.batch_id !== undefined ? { batch_id: args.batch_id } : {}),
        });
        return toolResult(result as unknown as Record<string, unknown>);
      } catch (e) {
        if (e instanceof FeatureNotEnabledError) return featureNotEnabledResult(e);
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_evaluate_stream — POST /v1/evaluate/stream (buffered)
  //
  // MCP tool calls are request/response. This tool BUFFERS the SSE stream
  // and returns the complete result set (same shape as the batch tool) once
  // the terminal `event: complete` arrives. Per-item RPC failures arrive as
  // `event: error` frames and surface in the items array with a `{ error }`
  // shape; the stream itself does not abort on per-item failure.
  //
  // True per-item streaming to the MCP host is left to Streamable HTTP
  // transports via the spec's server-sent progress channel — out of scope
  // for the tool surface itself (the tool returns one value).
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_evaluate_stream",
    {
      title: "AtlaSent — Evaluate (streamed, buffered)",
      description:
        "Evaluate up to 100 actions via the streaming endpoint. The tool buffers " +
        "the SSE stream and returns the complete result set (same shape as " +
        "atlasent_evaluate_many). Per-item RPC failures surface in the items " +
        "array with `{ error }`; the stream continues. Closed-by-default: 404 " +
        "surfaces as a `feature_not_enabled` error tagged with the `v2_streaming` " +
        "tenant flag.",
      inputSchema: z.object({
        items: z
          .array(batchItemSchema)
          .min(1)
          .max(MAX_BATCH_ITEMS)
          .describe("Items to evaluate (1-100). Decisions returned in input order."),
        batch_id: uuid.optional().describe("Optional UUID for idempotency."),
      }),
      annotations: {
        title: "AtlaSent — Evaluate Stream",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const items: BatchEvaluateItem[] = args.items.map((it) => ({
          action: it.action,
          agent: it.agent,
          ...(it.context !== undefined ? { context: it.context } : {}),
        }));
        const result = await evaluateStream({
          items,
          ...(args.batch_id !== undefined ? { batch_id: args.batch_id } : {}),
        });
        return toolResult(result as unknown as Record<string, unknown>);
      } catch (e) {
        if (e instanceof FeatureNotEnabledError) return featureNotEnabledResult(e);
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_query — POST /v1/graphql (read-only)
  //
  // The Wave A GraphQL schema has no mutations — `recentEvaluations(limit)`
  // and `activeBundle` only. We expose this as a read-only tool. Body /
  // depth / op-count caps are enforced server-side per the API contract;
  // this tool only enforces a defensive query-length cap on the way in.
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_query",
    {
      title: "AtlaSent — GraphQL Query (read-only)",
      description:
        "Run a read-only GraphQL query against the AtlaSent V2 GraphQL endpoint. " +
        "Wave A schema: `recentEvaluations(limit)`, `activeBundle`. Body limit " +
        "1MB, depth limit 8, one operation per request (enforced server-side). " +
        "Closed-by-default: 404 surfaces as a `feature_not_enabled` error tagged " +
        "with the `v2_graphql` tenant flag.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(MAX_GRAPHQL_QUERY_LEN)
          .describe("GraphQL query string. The Wave A schema is read-only."),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional GraphQL variables object."),
      }),
      annotations: {
        title: "AtlaSent — GraphQL Query",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await graphqlQuery({
          query: args.query,
          ...(args.variables !== undefined ? { variables: args.variables } : {}),
        });
        return toolResult(result as unknown as Record<string, unknown>);
      } catch (e) {
        if (e instanceof FeatureNotEnabledError) return featureNotEnabledResult(e);
        return toolError(e);
      }
    },
  );
}
