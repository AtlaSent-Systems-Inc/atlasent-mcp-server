/**
 * MCP server exposing AtlaSent authorization as tools.
 *
 *   evaluate       — ask for a decision; agent gates itself on the result
 *   verify_permit  — close the audit loop after the action runs
 *   deploy_service — DEMO protected tool: every call goes through `authorize()`
 *                    BEFORE executing the deploy. Denied calls never run.
 *
 * The `deploy_service` tool is the small end-to-end proof: it owns the
 * interception point. Look at its handler to see the exact pattern every
 * protected tool should follow.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
  // Log to stderr so we don't interfere with MCP stdio messaging.
  const line = JSON.stringify({ ts: new Date().toISOString(), event, mode: getMode(), ...data });
  process.stderr.write(line + "\n");
}

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
  //
  // This is the authorization-before-execution proof. The tool:
  //   1. builds an ActionContext
  //   2. calls authorize(ctx) — this is the INTERCEPTION POINT
  //   3. if decision is not "allow", returns the decision as-is (call blocked)
  //   4. otherwise executes, then returns the allow decision with the result
  //
  // In production, your domain tools live on other MCP servers. They call
  // AtlaSent's evaluate tool before executing. This demo co-locates the
  // pattern so you can run `evaluate → act → verify` end-to-end today.
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

      // Execute the deploy (simulated — real integrations would call out here).
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

  return server;
}
