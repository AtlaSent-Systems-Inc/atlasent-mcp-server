#!/usr/bin/env node
/**
 * Entry point for the AtlaSent MCP server.
 *
 * Transport selection:
 *   ATLASENT_TRANSPORT=http  → HTTP server (StreamableHTTP or SSE fallback)
 *   (unset / anything else)  → stdio (default MCP transport)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { registerPolicyResources } from "./resources.js";
import { startHttpServer } from "./http-transport.js";
import { listPoliciesInputSchema, listPoliciesHandler } from "./tools/list-policies.js";
import { simulateActionInputSchema, simulateActionHandler } from "./tools/simulate-action.js";
import { explainDenyInputSchema, explainDenyHandler } from "./tools/explain-deny.js";

const ATLASENT_BASE_URL = (process.env.ATLASENT_API_URL ?? 'https://api.atlasent.io').replace(/\/$/, '');
const ATLASENT_API_KEY = process.env.ATLASENT_API_KEY ?? '';

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${ATLASENT_BASE_URL}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(ATLASENT_API_KEY ? { Authorization: `Bearer ${ATLASENT_API_KEY}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

async function main(): Promise<void> {
  const server = createServer();

  // Register the atlasent://policies/{policyId} resource template.
  registerPolicyResources(server);

  // -------------------------------------------------------------------------
  // list_policies — list available governance policies
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_policies',
    {
      title: 'AtlaSent — List Policies',
      description: 'List available AtlaSent governance policies. Optionally filter by pack name (e.g. gxp, hipaa, soc2).',
      inputSchema: listPoliciesInputSchema,
      annotations: {
        title: 'AtlaSent — List Policies',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => listPoliciesHandler(args, apiFetch),
  );

  // -------------------------------------------------------------------------
  // simulate_action — dry-run policy evaluation (not recorded to audit trail)
  // -------------------------------------------------------------------------
  server.registerTool(
    'simulate_action',
    {
      title: 'AtlaSent — Simulate Action (Dry Run)',
      description:
        'Simulate a policy evaluation without recording it to the audit trail. ' +
        'Use this to preview what decision would be made for a given action and context.',
      inputSchema: simulateActionInputSchema,
      annotations: {
        title: 'AtlaSent — Simulate Action',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => simulateActionHandler(args, apiFetch),
  );

  // -------------------------------------------------------------------------
  // explain_deny — retrieve full explanation for a denied evaluation
  // -------------------------------------------------------------------------
  server.registerTool(
    'explain_deny',
    {
      title: 'AtlaSent — Explain Deny',
      description:
        'Retrieve a full explanation for a previous evaluation, including the matched ' +
        'rule, reason, and policy clause. Most useful when a prior evaluate call returned a deny decision.',
      inputSchema: explainDenyInputSchema,
      annotations: {
        title: 'AtlaSent — Explain Deny',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => explainDenyHandler(args, apiFetch),
  );

  const transport = (process.env.ATLASENT_TRANSPORT ?? "").toLowerCase();

  if (transport === "http") {
    // HTTP transport — server.connect() is called inside startHttpServer.
    await startHttpServer(server);
    // Keep the process alive.
    await new Promise<void>(() => {/* intentionally never resolves */});
  } else {
    // Default: stdio transport.
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
  }

  // HTTP transport mode: npx atlasent-mcp-server --transport http
  if (process.argv.indexOf('--transport') !== -1 &&
      process.argv[process.argv.indexOf('--transport') + 1] === 'http') {
    const { startHttpServer } = require('./http-server');
    startHttpServer(async (body: unknown) => ({ jsonrpc: '2.0', result: 'HTTP transport placeholder' }));
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
