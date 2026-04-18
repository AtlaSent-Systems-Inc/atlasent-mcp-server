/**
 * MCP resource handler for atlasent://policies/{id}.
 *
 * Registers a resource template so MCP clients can fetch policy
 * definitions as structured JSON. In remote mode the handler fetches
 * from the AtlaSent API; in local mode it returns a built-in stub
 * policy that mirrors the local engine's decision logic.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMode } from "./engine.js";

// ---------------------------------------------------------------------------
// Local stub — mirrors the rules documented in localEngine.ts
// ---------------------------------------------------------------------------

function localPolicyStub(policyId: string): Record<string, unknown> {
  return {
    id: policyId,
    source: "local",
    version: "1.0.0",
    description:
      "Local-mode policy stub. Configure ATLASENT_API_KEY and ATLASENT_BASE_URL to load real policies.",
    rules: [
      {
        id: "prod-requires-approval",
        condition: "environment == 'production' && approvals.length == 0",
        decision: "deny",
        reason: "Production actions require at least one approval.",
      },
      {
        id: "destructive-requires-window",
        condition: "isDestructive(action_type) && !change_window",
        decision: "hold",
        reason: "Destructive actions require a scheduled change_window.",
      },
      {
        id: "default-allow",
        condition: "true",
        decision: "allow",
      },
    ],
    retrieved_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Remote fetch
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;
const SDK_VERSION = "1.0.0";

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": `@atlasent/mcp-server/${SDK_VERSION}`,
  };
  const key = process.env.ATLASENT_API_KEY;
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const anon = process.env.ATLASENT_ANON_KEY;
  if (anon) headers["x-anon-key"] = anon;
  return headers;
}

function baseUrl(): string {
  return (process.env.ATLASENT_BASE_URL ?? "https://api.atlasent.com").replace(/\/+$/, "");
}

async function fetchRemotePolicy(policyId: string): Promise<Record<string, unknown>> {
  const url = `${baseUrl()}/v1-policies/${encodeURIComponent(policyId)}`;
  const res = await fetch(url, {
    headers: buildHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AtlaSent API ${res.status}: ${text}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the `atlasent://policies/{policyId}` resource template on the
 * given McpServer instance.
 *
 * Call this immediately after `createServer()` returns.
 */
export function registerPolicyResources(server: McpServer): void {
  server.registerResourceTemplate(
    new ResourceTemplate("atlasent://policies/{policyId}", {
      list: async () => ({
        resources: [
          {
            uri: "atlasent://policies/default",
            name: "Default Policy",
            description: "The default AtlaSent authorization policy.",
            mimeType: "application/json",
          },
        ],
      }),
    }),
    {
      title: "AtlaSent Policy",
      description:
        "Fetch the JSON representation of an AtlaSent authorization policy by id. " +
        'Use "default" to retrieve the active policy.',
    },
    async (uri, variables) => {
      const policyId =
        typeof variables["policyId"] === "string" ? variables["policyId"] : "default";

      let policy: Record<string, unknown>;

      if (getMode() === "remote") {
        try {
          policy = await fetchRemotePolicy(policyId);
        } catch (err) {
          // Degrade gracefully — surface error in the resource body so the
          // agent can report it rather than crashing the server.
          policy = {
            id: policyId,
            error: err instanceof Error ? err.message : String(err),
            retrieved_at: new Date().toISOString(),
          };
        }
      } else {
        policy = localPolicyStub(policyId);
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
}
