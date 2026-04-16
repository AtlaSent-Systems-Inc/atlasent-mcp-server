#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration from environment variables
// ---------------------------------------------------------------------------

const ATLASENT_API_KEY = process.env.ATLASENT_API_KEY ?? "";
const ATLASENT_ANON_KEY = process.env.ATLASENT_ANON_KEY ?? "";
const ATLASENT_BASE_URL = (
  process.env.ATLASENT_BASE_URL ?? "https://api.atlasent.com"
).replace(/\/+$/, ""); // strip trailing slashes

// ---------------------------------------------------------------------------
// Shared types & helpers
// ---------------------------------------------------------------------------

interface EvaluateResponse {
  decision: string;
  permit_token: string;
}

interface VerifyPermitResponse {
  outcome: string;
  valid: boolean;
}

/** Fail-closed deny result used whenever an error occurs. */
function deny(reason: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ decision: "deny", reason }) }],
    isError: true,
  };
}

/**
 * POST JSON to an AtlaSent API endpoint.
 * Throws on any network / non-2xx error so callers can catch and deny.
 */
async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const url = `${ATLASENT_BASE_URL}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (ATLASENT_API_KEY) headers["Authorization"] = `Bearer ${ATLASENT_API_KEY}`;
  if (ATLASENT_ANON_KEY) headers["x-anon-key"] = ATLASENT_ANON_KEY;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AtlaSent API ${res.status}: ${text}`);
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "@atlasent/mcp-server",
  version: "1.0.0",
});

// ----- evaluate tool -------------------------------------------------------

server.registerTool(
  "evaluate",
  {
    title: "AtlaSent Evaluate",
    description:
      "Evaluate a proposed action against AtlaSent safety policies. " +
      "Returns a decision (allow / deny / escalate) and a permit_token that " +
      "can later be verified with verify_permit.",
    inputSchema: {
      action_type: z.string().describe("The type of action being evaluated (e.g. deploy, release, merge)."),
      actor_id: z.string().describe("Identifier for the actor performing the action."),
      environment: z.string().describe("Target environment (e.g. production, staging)."),
      approvals: z
        .array(z.string())
        .optional()
        .describe("List of approval identifiers already obtained."),
      change_window: z
        .string()
        .optional()
        .describe("ISO-8601 time window during which the change is scheduled."),
    },
  },
  async (args) => {
    try {
      const body: Record<string, unknown> = {
        action_type: args.action_type,
        actor_id: args.actor_id,
        environment: args.environment,
      };
      if (args.approvals !== undefined) body.approvals = args.approvals;
      if (args.change_window !== undefined) body.change_window = args.change_window;

      const data = await post<EvaluateResponse>("/v1-evaluate", body);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              decision: data.decision,
              permit_token: data.permit_token,
            }),
          },
        ],
      };
    } catch (err) {
      return deny(err instanceof Error ? err.message : String(err));
    }
  },
);

// ----- verify_permit tool --------------------------------------------------

server.registerTool(
  "verify_permit",
  {
    title: "AtlaSent Verify Permit",
    description:
      "Verify a previously issued permit token against AtlaSent. " +
      "Returns the outcome and whether the permit is still valid.",
    inputSchema: {
      permit_token: z.string().describe("The permit token returned by a prior evaluate call."),
      action_type: z.string().describe("The type of action being verified."),
      actor_id: z.string().describe("Identifier for the actor performing the action."),
      environment: z.string().describe("Target environment (e.g. production, staging)."),
      approvals: z
        .array(z.string())
        .optional()
        .describe("List of approval identifiers already obtained."),
      change_window: z
        .string()
        .optional()
        .describe("ISO-8601 time window during which the change is scheduled."),
    },
  },
  async (args) => {
    try {
      const body: Record<string, unknown> = {
        permit_token: args.permit_token,
        action_type: args.action_type,
        actor_id: args.actor_id,
        environment: args.environment,
      };
      if (args.approvals !== undefined) body.approvals = args.approvals;
      if (args.change_window !== undefined) body.change_window = args.change_window;

      const data = await post<VerifyPermitResponse>("/v1-verify-permit", body);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              outcome: data.outcome,
              valid: data.valid,
            }),
          },
        ],
      };
    } catch (err) {
      return deny(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
