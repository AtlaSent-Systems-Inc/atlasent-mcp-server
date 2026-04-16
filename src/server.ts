import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const VERSION = "1.0.0";

interface EvaluateResponse {
  decision: string;
  permit_token: string;
  reason?: string;
  audit_id?: string;
  conditions?: string[];
}

interface VerifyPermitResponse {
  outcome: string;
  valid: boolean;
  reason?: string;
  audit_id?: string;
}

function deny(reason: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ decision: "deny", reason }) }],
    isError: true as const,
  };
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const baseUrl = (
    process.env.ATLASENT_BASE_URL ?? "https://api.atlasent.com"
  ).replace(/\/+$/, "");
  const apiKey = process.env.ATLASENT_API_KEY ?? "";
  const anonKey = process.env.ATLASENT_ANON_KEY ?? "";

  const url = `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `@atlasent/mcp-server/${VERSION}`,
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (anonKey) headers["x-anon-key"] = anonKey;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AtlaSent API ${res.status}: ${text}`);
  }

  return (await res.json()) as T;
}

const actionType = z.string().describe(
  "The action the agent is about to perform (e.g. deploy, delete, merge, execute_query, send_email)."
);
const actorId = z.string().describe(
  "Identifier for the user or service account the agent is acting on behalf of."
);
const environment = z.string().describe(
  "Target environment for the action (e.g. production, staging, development)."
);
const approvals = z.array(z.string()).optional().describe(
  "Approval identifiers already obtained for this action (e.g. ticket IDs, reviewer handles)."
);
const changeWindow = z.string().optional().describe(
  "ISO-8601 time window during which the change is permitted (e.g. 2025-01-15T02:00:00Z/PT4H)."
);

export function createServer(): McpServer {
  const server = new McpServer({
    name: "@atlasent/mcp-server",
    version: VERSION,
  });

  server.registerTool(
    "evaluate",
    {
      title: "AtlaSent — Evaluate Action",
      description:
        "Call this BEFORE performing any sensitive action. Sends the action context to " +
        "AtlaSent and returns an authorization decision. If the decision is 'allow', " +
        "you will receive a permit_token — pass it to verify_permit after completing the " +
        "action. If the decision is 'deny', you MUST NOT proceed. If 'escalate', inform " +
        "the user that manual approval is required.",
      inputSchema: {
        action_type: actionType,
        actor_id: actorId,
        environment,
        approvals,
        change_window: changeWindow,
      },
      annotations: {
        title: "AtlaSent — Evaluate Action",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
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
                ...(data.reason && { reason: data.reason }),
                ...(data.audit_id && { audit_id: data.audit_id }),
                ...(data.conditions?.length && { conditions: data.conditions }),
              }),
            },
          ],
        };
      } catch (err) {
        return deny(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "verify_permit",
    {
      title: "AtlaSent — Verify Permit",
      description:
        "Call this AFTER completing a previously authorized action. Sends the permit_token " +
        "(returned by evaluate) back to AtlaSent to confirm the action was performed " +
        "within its authorized scope. Returns whether the permit is still valid. " +
        "This closes the audit loop — every evaluate should be followed by a verify_permit.",
      inputSchema: {
        permit_token: z.string().describe(
          "The permit_token returned by a prior evaluate call."
        ),
        action_type: actionType,
        actor_id: actorId,
        environment,
        approvals,
        change_window: changeWindow,
      },
      annotations: {
        title: "AtlaSent — Verify Permit",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
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
                ...(data.reason && { reason: data.reason }),
                ...(data.audit_id && { audit_id: data.audit_id }),
              }),
            },
          ],
        };
      } catch (err) {
        return deny(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}
