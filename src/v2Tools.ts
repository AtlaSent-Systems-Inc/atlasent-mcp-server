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
 * Behavior-aware gates (C.MCP1): when ATLASENT_BEHAVIOR_BASE_URL is set
 * and v2_behavior_conditioning is active, user state is attached to each
 * item's context before forwarding. escalate decisions surface as a
 * distinct { error: "escalate" } result. Behavior fetch errors are
 * fail-open (the request proceeds without behavior context).
 *
 * Fail-closed audit (C.MCP3): every tool call emits a mcp.request audit
 * event to stderr before execution.
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

// C.MCP3: fail-closed audit — every tool call emits mcp.request to stderr.
function logAudit(toolName: string, extra?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    event: "mcp.request",
    transport: "mcp-tool",
    tool_name: toolName,
    ...extra,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// C.MCP1: behavior client — reads redacted StateSummary from behavior-insights.
// Fail-open: returns {} on any error.
interface StateSummary {
  event_count: number;
  window_start: string;
  window_end: string;
  category_counts: Record<string, number>;
}

async function fetchBehaviorContext(userId: string): Promise<Record<string, unknown>> {
  const baseUrl = process.env.ATLASENT_BEHAVIOR_BASE_URL;
  const apiKey = process.env.ATLASENT_BEHAVIOR_API_KEY;
  if (!baseUrl || !apiKey) return {};
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(
      `${baseUrl.replace(/\/$/, "")}/api/patterns/summary/${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    if (!res.ok) return {};
    const summary = (await res.json()) as StateSummary | null;
    if (!summary) return {};
    return {
      user_state: {
        event_count: summary.event_count,
        window_start: summary.window_start,
        window_end: summary.window_end,
        confidence_low: Object.keys(summary.category_counts ?? {}).length === 0,
      },
    };
  } catch {
    return {};
  }
}

// C.MCP1: enrich batch items with behavior context when user_id is present.
async function enrichItemsWithBehavior(
  items: BatchEvaluateItem[],
): Promise<BatchEvaluateItem[]> {
  if (!process.env.ATLASENT_BEHAVIOR_BASE_URL) return items;
  return Promise.all(
    items.map(async (item) => {
      const userId =
        item.context &&
        typeof item.context === "object" &&
        typeof (item.context as Record<string, unknown>).user_id === "string"
          ? (item.context as Record<string, unknown>).user_id as string
          : null;
      if (!userId) return item;
      const behaviorCtx = await fetchBehaviorContext(userId);
      if (Object.keys(behaviorCtx).length === 0) return item;
      return {
        ...item,
        context: { ...(item.context as Record<string, unknown>), ...behaviorCtx },
      };
    }),
  );
}

// C.MCP1: map escalate decision to distinct error surface.
function checkEscalate(result: unknown): ReturnType<typeof toolResult> | null {
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (result as Record<string, unknown>).decision === "escalate"
  ) {
    return toolResult({
      error: "escalate",
      reasons: (result as Record<string, unknown>).reasons ?? [],
      message:
        "Decision returned escalate — route to human review before proceeding.",
    });
  }
  return null;
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
      logAudit("atlasent_evaluate_many");
      if (process.env.ATLASENT_MCP_READONLY === "1" || process.env.ATLASENT_MCP_READONLY === "true") {
        return toolResult({ error: "readonly", message: "Tool disabled: ATLASENT_MCP_READONLY=1" });
      }
      try {
        let items: BatchEvaluateItem[] = args.items.map((it) => ({
          action: it.action,
          agent: it.agent,
          ...(it.context !== undefined ? { context: it.context } : {}),
        }));
        // C.MCP1: enrich with behavior context
        items = await enrichItemsWithBehavior(items);
        const result = await evaluateBatch({
          items,
          ...(args.batch_id !== undefined ? { batch_id: args.batch_id } : {}),
        });
        // C.MCP1: surface escalate as distinct error
        const escalateResult = checkEscalate(result);
        if (escalateResult) return escalateResult;
        return toolResult(result as unknown as Record<string, unknown>);
      } catch (e) {
        if (e instanceof FeatureNotEnabledError) return featureNotEnabledResult(e);
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_evaluate_stream — POST /v1/evaluate/stream (buffered)
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
      logAudit("atlasent_evaluate_stream");
      if (process.env.ATLASENT_MCP_READONLY === "1" || process.env.ATLASENT_MCP_READONLY === "true") {
        return toolResult({ error: "readonly", message: "Tool disabled: ATLASENT_MCP_READONLY=1" });
      }
      try {
        let items: BatchEvaluateItem[] = args.items.map((it) => ({
          action: it.action,
          agent: it.agent,
          ...(it.context !== undefined ? { context: it.context } : {}),
        }));
        // C.MCP1: enrich with behavior context
        items = await enrichItemsWithBehavior(items);
        const result = await evaluateStream({
          items,
          ...(args.batch_id !== undefined ? { batch_id: args.batch_id } : {}),
        });
        const escalateResult = checkEscalate(result);
        if (escalateResult) return escalateResult;
        return toolResult(result as unknown as Record<string, unknown>);
      } catch (e) {
        if (e instanceof FeatureNotEnabledError) return featureNotEnabledResult(e);
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // atlasent_query — POST /v1/graphql (read-only)
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
      logAudit("atlasent_query");
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
