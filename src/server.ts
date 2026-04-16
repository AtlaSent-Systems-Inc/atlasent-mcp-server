import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const ContextSchema = z.object({
  action_type: z.string().describe("The type of action being evaluated"),
  actor_id: z.string().describe("The ID of the actor requesting the action"),
  environment: z.string().describe("The environment (e.g. production, staging)"),
  approvals: z
    .array(z.string())
    .optional()
    .describe("List of approver IDs who have approved the action"),
  change_window: z
    .string()
    .optional()
    .describe("The change window identifier for scheduled maintenance"),
});

const EvaluateSchema = ContextSchema;

const VerifyPermitSchema = ContextSchema.extend({
  permit_token: z.string().describe("The permit token returned from evaluate"),
});

interface EvaluateResponse {
  decision: string;
  permit_token?: string;
}

interface VerifyPermitResponse {
  outcome: string;
  valid: boolean;
}

function getConfig(): { apiKey: string; anonKey: string; baseUrl: string } {
  const apiKey = process.env.ATLASENT_API_KEY ?? "";
  const anonKey = process.env.ATLASENT_ANON_KEY ?? "";
  const baseUrl =
    process.env.ATLASENT_BASE_URL ?? "https://api.atlasent.io";

  return { apiKey, anonKey, baseUrl };
}

async function callAtlaSent<T>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const { apiKey, anonKey, baseUrl } = getConfig();

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      apikey: anonKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `AtlaSent API error: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<T>;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "atlasent-mcp-server",
    version: "1.0.0",
  });

  server.tool(
    "evaluate",
    "Evaluate whether an action should be permitted by calling the AtlaSent policy engine. Returns a decision (allow/deny) and a permit_token when allowed.",
    EvaluateSchema.shape,
    async (args) => {
      try {
        const { action_type, actor_id, environment, approvals, change_window } =
          args;

        const body: Record<string, unknown> = {
          action_type,
          actor_id,
          environment,
        };
        if (approvals !== undefined) body.approvals = approvals;
        if (change_window !== undefined) body.change_window = change_window;

        const result = await callAtlaSent<EvaluateResponse>(
          "/v1-evaluate",
          body
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ decision: "deny" }),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "verify_permit",
    "Verify a previously issued permit token is still valid by calling the AtlaSent policy engine. Returns outcome and valid flag.",
    VerifyPermitSchema.shape,
    async (args) => {
      try {
        const {
          permit_token,
          action_type,
          actor_id,
          environment,
          approvals,
          change_window,
        } = args;

        const body: Record<string, unknown> = {
          permit_token,
          action_type,
          actor_id,
          environment,
        };
        if (approvals !== undefined) body.approvals = approvals;
        if (change_window !== undefined) body.change_window = change_window;

        const result = await callAtlaSent<VerifyPermitResponse>(
          "/v1-verify-permit",
          body
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ outcome: "deny", valid: false }),
            },
          ],
        };
      }
    }
  );

  return server;
}
