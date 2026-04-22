/**
 * MCP server exposing AtlaSent authorization as tools.
 *
 * Two categories of tools:
 *
 * 1. AtlaSent primitives — for agents that gate their own tool calls.
 *      evaluate       — ask AtlaSent for a decision
 *      verify_permit  — close the audit loop after the action runs
 *
 * 2. Protected demo tools — show the authorization-before-execution pattern.
 *      send_email                 — blocked if recipient is external, no approval
 *      access_sensitive_dataset   — blocked if classification is sensitive, no approval
 *      write_to_production        — blocked if production + no approval
 *      deploy_service             — the original demo tool (kept for back-compat)
 *
 * Every protected tool follows the same 20-line pattern:
 *
 *   const ctx: ActionContext = { action_type, actor_id, environment, context };
 *   const decision = await authorize(ctx);     // ← INTERCEPTION POINT
 *   if (decision.decision !== "allow") {
 *     return toolResult(decision);             // blocked; nothing executes
 *   }
 *   const result = /* run the action * /;
 *   return toolResult(decision, { result });
 *
 * The guarantee: if `authorize()` does not return `allow`, the action code
 * never runs. This is the one invariant the demo proves.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { toolError, toolResult, type ActionContext } from "./decision.js";
import { authorize, getMode, verify } from "./engine.js";

export const VERSION = "1.0.0";

const actionType = z
  .string()
  .meta({ description: "The action the agent is about to perform (e.g. deploy, delete, merge, execute_query, send_email)." });
const actorId = z
  .string()
  .meta({ description: "Identifier for the user or service account the agent is acting on behalf of." });
const environment = z
  .string()
  .meta({ description: "Target environment for the action (e.g. production, staging, development)." });
const approvals = z
  .array(z.string())
  .optional()
  .meta({ description: "Approval identifiers already obtained for this action (e.g. ticket IDs, reviewer handles)." });
const changeWindow = z
  .string()
  .optional()
  .meta({ description: "ISO-8601 time window during which the change is permitted (e.g. 2025-01-15T02:00:00Z/PT4H)." });
const contextBag = z
  .record(z.string(), z.any())
  .optional()
  .meta({ description: "Free-form attributes the policy may inspect (recipient, sensitivity, payload_preview, ...)." });

function log(event: string, data: Record<string, unknown>): void {
  // Log to stderr so we don't interfere with MCP stdio messaging.
  const line = JSON.stringify({ ts: new Date().toISOString(), event, mode: getMode(), ...data });
  process.stderr.write(line + "\n");
}

// Organization-internal email domains. External recipients trigger a block
// in the local engine (via context.external === true).
const INTERNAL_EMAIL_DOMAINS = new Set(["acme.corp", "example.com"]);

// Tiny demo classifier — real deployments look this up in a data catalog.
function classifyDataset(datasetId: string): "public" | "internal" | "pii" | "phi" {
  const id = datasetId.toLowerCase();
  if (id.includes("pii") || id.includes("customers") || id.includes("users")) return "pii";
  if (id.includes("phi") || id.includes("health") || id.includes("medical")) return "phi";
  if (id.includes("public")) return "public";
  return "internal";
}

function isSensitiveClassification(c: string): boolean {
  return c === "pii" || c === "phi";
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
      inputSchema: z.object({
        action_type: actionType,
        actor_id: actorId,
        environment,
        approvals,
        change_window: changeWindow,
        context: contextBag,
      }),
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
        ...(args.context && { context: args.context as Record<string, unknown> }),
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
      inputSchema: z.object({
        permit_token: z.string().meta({ description: "The permit_token returned by a prior evaluate call." }),
        action_type: actionType,
        actor_id: actorId,
        environment,
        approvals,
        change_window: changeWindow,
        context: contextBag,
      }),
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
        ...(args.context && { context: args.context as Record<string, unknown> }),
      };
      const result = await verify(args.permit_token, ctx);
      log("verify_permit", { ctx, permit_token: args.permit_token, result });
      return toolResult(result);
    },
  );

  // -------------------------------------------------------------------------
  // send_email — authorization-gated demo tool
  //
  // Shows recipient-based blocking: sending to an external domain without a
  // named approver is blocked before the email is "sent".
  // -------------------------------------------------------------------------
  server.registerTool(
    "send_email",
    {
      title: "Demo: Send Email (authorization-gated)",
      description:
        "Example protected tool. Every call is authorized by AtlaSent BEFORE the " +
        "email is sent. External recipients require an approval; internal " +
        "recipients send without one.",
      inputSchema: z.object({
        to: z.string().meta({ description: "Recipient email address." }),
        subject: z.string().meta({ description: "Email subject." }),
        body: z.string().meta({ description: "Email body." }),
        actor_id: actorId,
        approvals,
      }),
      annotations: {
        title: "Demo: Send Email",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const domain = args.to.split("@")[1]?.toLowerCase() ?? "";
      const external = !INTERNAL_EMAIL_DOMAINS.has(domain);

      const ctx: ActionContext = {
        action_type: "send_email",
        actor_id: args.actor_id,
        environment: "default",
        ...(args.approvals && { approvals: args.approvals }),
        context: {
          recipient: args.to,
          recipient_domain: domain,
          external,
          subject: args.subject,
        },
      };

      // ---- INTERCEPTION POINT --------------------------------------------
      const decision = await authorize(ctx);
      log("send_email.authorize", { to: args.to, external, decision });

      if (decision.decision !== "allow") {
        log("send_email.blocked", { to: args.to, reason: (decision as { reason?: string }).reason });
        return toolResult(decision);
      }
      // --------------------------------------------------------------------

      try {
        // Execute the send (simulated — real integrations would call out here).
        const result = {
          status: "sent",
          to: args.to,
          subject: args.subject,
          sent_at: new Date().toISOString(),
        };
        log("send_email.executed", { to: args.to, permit_token: decision.permit_token });
        return toolResult(decision, { result });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), {
          tool: "send_email",
          permit_token: decision.permit_token,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // access_sensitive_dataset — authorization-gated demo tool
  //
  // Shows classification-based blocking: pulling PII / PHI requires an
  // approval. Access to public datasets proceeds without one.
  // -------------------------------------------------------------------------
  server.registerTool(
    "access_sensitive_dataset",
    {
      title: "Demo: Access Dataset (authorization-gated)",
      description:
        "Example protected tool. Every call is authorized by AtlaSent BEFORE the " +
        "dataset is read. PII/PHI datasets require an approval; public datasets " +
        "do not.",
      inputSchema: z.object({
        dataset_id: z.string().meta({ description: "Identifier of the dataset to read." }),
        purpose: z.string().meta({ description: "Why the agent needs the data (shown to reviewers)." }),
        actor_id: actorId,
        approvals,
      }),
      annotations: {
        title: "Demo: Access Dataset",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const classification = classifyDataset(args.dataset_id);
      const sensitivityLevel =
        classification === "pii" ? "pii" : classification === "phi" ? "phi" : "low";

      const ctx: ActionContext = {
        action_type: "access_dataset",
        actor_id: args.actor_id,
        environment: "default",
        ...(args.approvals && { approvals: args.approvals }),
        context: {
          dataset_id: args.dataset_id,
          classification,
          sensitivity: sensitivityLevel,
          purpose: args.purpose,
        },
      };

      // ---- INTERCEPTION POINT --------------------------------------------
      const decision = await authorize(ctx);
      log("access_sensitive_dataset.authorize", { dataset: args.dataset_id, classification, decision });

      if (decision.decision !== "allow") {
        log("access_sensitive_dataset.blocked", {
          dataset: args.dataset_id,
          reason: (decision as { reason?: string }).reason,
        });
        return toolResult(decision);
      }
      // --------------------------------------------------------------------

      try {
        // Execute the read (simulated).
        const result = {
          dataset_id: args.dataset_id,
          classification,
          row_count: isSensitiveClassification(classification) ? 0 : 42,
          rows: isSensitiveClassification(classification)
            ? []
            : [
                { id: 1, value: "alpha" },
                { id: 2, value: "beta" },
              ],
          read_at: new Date().toISOString(),
        };
        log("access_sensitive_dataset.executed", {
          dataset: args.dataset_id,
          permit_token: decision.permit_token,
        });
        return toolResult(decision, { result });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), {
          tool: "access_sensitive_dataset",
          permit_token: decision.permit_token,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // write_to_production — authorization-gated demo tool
  //
  // Shows environment-based blocking: any write to a production system
  // requires an approval. Staging writes proceed without one.
  // -------------------------------------------------------------------------
  server.registerTool(
    "write_to_production",
    {
      title: "Demo: Write to Production System (authorization-gated)",
      description:
        "Example protected tool. Every call is authorized by AtlaSent BEFORE the " +
        "write is applied. Production writes require an approval; non-production " +
        "writes do not.",
      inputSchema: z.object({
        system: z.string().meta({ description: "Name of the downstream system to write to (e.g. 'billing-db', 'payments-api')." }),
        operation: z.string().meta({ description: "What is being written (e.g. 'update_customer', 'apply_refund')." }),
        payload: z.record(z.string(), z.any()).meta({ description: "Write payload. Summarized into context for the policy; never logged in full." }),
        environment,
        actor_id: actorId,
        approvals,
      }),
      annotations: {
        title: "Demo: Write to Production System",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const payloadPreview = JSON.stringify(args.payload).slice(0, 200);

      const ctx: ActionContext = {
        action_type: "write",
        actor_id: args.actor_id,
        environment: args.environment,
        ...(args.approvals && { approvals: args.approvals }),
        context: {
          system: args.system,
          operation: args.operation,
          payload_preview: payloadPreview,
        },
      };

      // ---- INTERCEPTION POINT --------------------------------------------
      const decision = await authorize(ctx);
      log("write_to_production.authorize", { system: args.system, operation: args.operation, decision });

      if (decision.decision !== "allow") {
        log("write_to_production.blocked", {
          system: args.system,
          reason: (decision as { reason?: string }).reason,
        });
        return toolResult(decision);
      }
      // --------------------------------------------------------------------

      try {
        // Execute the write (simulated).
        const result = {
          status: "written",
          system: args.system,
          operation: args.operation,
          environment: args.environment,
          written_at: new Date().toISOString(),
        };
        log("write_to_production.executed", {
          system: args.system,
          permit_token: decision.permit_token,
        });
        return toolResult(decision, { result });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), {
          tool: "write_to_production",
          permit_token: decision.permit_token,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // deploy_service — original demo tool (kept for back-compat / tests)
  // -------------------------------------------------------------------------
  server.registerTool(
    "deploy_service",
    {
      title: "Demo: Deploy Service (authorization-gated)",
      description:
        "Example protected tool. Every call is authorized by AtlaSent BEFORE the " +
        "deploy runs. Denied or held calls are blocked and never touch the target " +
        "system. On allow, the deploy executes and a permit_token is returned.",
      inputSchema: z.object({
        service_name: z.string().meta({ description: "Name of the service to deploy." }),
        environment,
        actor_id: actorId,
        approvals,
        change_window: changeWindow,
      }),
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
        context: { service: args.service_name },
      };

      // ---- INTERCEPTION POINT --------------------------------------------
      const decision = await authorize(ctx);
      log("deploy_service.authorize", { service: args.service_name, ctx, decision });

      if (decision.decision !== "allow") {
        log("deploy_service.blocked", { service: args.service_name, reason: (decision as { reason?: string }).reason });
        return toolResult(decision);
      }
      // --------------------------------------------------------------------

      try {
        const result = {
          status: "deployed",
          service: args.service_name,
          environment: args.environment,
          deployed_at: new Date().toISOString(),
        };
        log("deploy_service.executed", { service: args.service_name, permit_token: decision.permit_token, result });
        return toolResult(decision, { result });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err), {
          tool: "deploy_service",
          permit_token: decision.permit_token,
        });
      }
    },
  );

  return server;
}
