/**
 * MCP server exposing AtlaSent authorization as tools and resources.
 *
 *   evaluate       — ask for a decision; agent gates itself on the result
 *   verify_permit  — close the audit loop after the action runs
 *   deploy_service — DEMO protected tool: every call goes through `authorize()`
 *                    BEFORE executing the deploy. Denied calls never run.
 *
 * Resources:
 *   atlasent://policies/{id} — expose policy/bundle definitions (read-only)
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolResult, type ActionContext } from "./decision.js";
import { authorize, verify, getMode } from "./engine.js";

export const VERSION = "1.0.0";

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

function log(event: string, data: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, mode: getMode(), ...data });
  process.stderr.write(line + "\n");
}

/** Fetch a policy bundle from the remote AtlaSent API. */
async function fetchRemotePolicy(id: string): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.ATLASENT_API_KEY;
  const baseUrl = (process.env.ATLASENT_BASE_URL ?? "https://api.atlasent.io").replace(/\/+$/, "");
  if (!apiKey) return null;

  try {
    const res = await fetch(`${baseUrl}/v1-bundles/${encodeURIComponent(id)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Built-in local policy definitions (used when mode is local). */
const LOCAL_POLICIES: Record<string, Record<string, unknown>> = {
  default: {
    id: "default",
    name: "Default Policy",
    description: "Built-in local policy: allows all actions in non-production environments, holds production deploys.",
    mode: "local",
    rules: [
      { decision: "allow", when: { field: "environment", neq: "production" } },
      { decision: "hold", when: { field: "environment", eq: "production" }, reason: "Production actions require human review in local mode." },
      { decision: "allow" },
    ],
  },
  "production-deploy": {
    id: "production-deploy",
    name: "Production Deploy Gate",
    description: "Requires approvals and a valid change window for production deployments.",
    mode: "local",
    rules: [
      { decision: "deny", when: { field: "environment", eq: "production", approvals_lt: 2 }, reason: "At least 2 approvals required for production." },
      { decision: "hold", when: { field: "environment", eq: "production", change_window: false }, reason: "Outside change window — action is queued for review." },
      { decision: "allow", when: { field: "environment", eq: "production" } },
      { decision: "allow", when: { field: "environment", neq: "production" } },
    ],
  },
};

export function createServer(): McpServer {
  const server = new McpServer({
    name: "@atlasent/mcp-server",
    version: VERSION,
  });

  // -------------------------------------------------------------------------
  // evaluate — for agents that gate their own tool calls
  // -------------------------------------------------------------------------
  server.registerTool(
    "evaluate",
    {
      title: "AtlaSent — Evaluate Action",
      description:
        "Call this BEFORE performing any sensitive action. Returns a Decision: " +
        "`allow` (use the permit_token and proceed), `deny` (you MUST NOT proceed), " +
        "or `hold` (action is queued for human review — do not proceed, inform the user).",
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
      const ctx: ActionContext = {
        action_type: args.action_type,
        actor_id: args.actor_id,
        environment: args.environment,
        ...(args.approvals && { approvals: args.approvals }),
        ...(args.change_window && { change_window: args.change_window }),
      };
      const decision = await authorize(ctx);
      log("evaluate", { ctx, decision });
      return toolResult(decision);
    },
  );

  // -------------------------------------------------------------------------
  // verify_permit — close the audit loop
  // -------------------------------------------------------------------------
  server.registerTool(
    "verify_permit",
    {
      title: "AtlaSent — Verify Permit",
      description:
        "Call this AFTER completing an authorized action. Confirms the permit " +
        "issued by `evaluate` is still valid. Outcome is `verified`, `expired`, " +
        "`invalid`, or `error`. If `valid` is false, the action should be flagged " +
        "for review.",
      inputSchema: {
        permit_token: z.string().describe("The permit_token returned by a prior evaluate call."),
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
      const ctx: ActionContext = {
        action_type: args.action_type,
        actor_id: args.actor_id,
        environment: args.environment,
        ...(args.approvals && { approvals: args.approvals }),
        ...(args.change_window && { change_window: args.change_window }),
      };
      const result = await verify(args.permit_token, ctx);
      log("verify_permit", { ctx, permit_token: args.permit_token, result });
      return toolResult(result);
    },
  );

  // -------------------------------------------------------------------------
  // deploy_service — DEMO protected tool
  // -------------------------------------------------------------------------
  server.registerTool(
    "deploy_service",
    {
      title: "Demo: Deploy Service (authorization-gated)",
      description:
        "Example protected tool. Every call is authorized by AtlaSent BEFORE the " +
        "deploy runs. Denied or held calls are blocked and never touch the target " +
        "system. On allow, the deploy executes and a permit_token is returned.",
      inputSchema: {
        service_name: z.string().describe("Name of the service to deploy."),
        environment,
        actor_id: actorId,
        approvals,
        change_window: changeWindow,
      },
      annotations: {
        title: "Demo: Deploy Service",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const ctx: ActionContext = {
        action_type: "deploy",
        actor_id: args.actor_id,
        environment: args.environment,
        ...(args.approvals && { approvals: args.approvals }),
        ...(args.change_window && { change_window: args.change_window }),
      };

      // ---- INTERCEPTION POINT --------------------------------------------
      const decision = await authorize(ctx);
      log("deploy_service.authorize", { service: args.service_name, ctx, decision });

      if (decision.decision !== "allow") {
        log("deploy_service.blocked", { service: args.service_name, reason: (decision as { reason?: string }).reason });
        return toolResult(decision);
      }
      // --------------------------------------------------------------------

      const result = {
        status: "deployed",
        service: args.service_name,
        environment: args.environment,
        deployed_at: new Date().toISOString(),
      };
      log("deploy_service.executed", { service: args.service_name, permit_token: decision.permit_token, result });

      return toolResult(decision, { result });
    },
  );

  // -------------------------------------------------------------------------
  // atlasent://policies/{id} — policy/bundle definitions resource
  //
  // In local mode: returns built-in policy definitions.
  // In remote mode: fetches the published bundle from the AtlaSent API.
  //
  // Agents can read policies to understand what rules govern their actions
  // before calling evaluate. This is a read-only, non-destructive operation.
  // -------------------------------------------------------------------------
  server.resource(
    "atlasent-policy",
    new ResourceTemplate("atlasent://policies/{id}", { list: undefined }),
    async (uri, { id }) => {
      const policyId = Array.isArray(id) ? id[0] : id;
      log("resource.policies", { id: policyId });

      let policy: Record<string, unknown> | null = null;

      if (getMode() === "remote") {
        policy = await fetchRemotePolicy(policyId);
      }

      if (!policy) {
        policy = LOCAL_POLICIES[policyId] ?? {
          id: policyId,
          name: policyId,
          description: "Policy not found. Check the policy ID or switch to remote mode.",
          mode: getMode(),
          rules: [],
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(policy, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
