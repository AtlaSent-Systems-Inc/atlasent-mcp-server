#!/usr/bin/env node
/**
 * AtlaSent MCP Server v2
 *
 * All tools proxy through the AtlaSent REST API.
 * Config via environment variables:
 *   ATLASENT_API_URL  — base URL (default: https://api.atlasent.io)
 *   ATLASENT_API_KEY  — org-scoped API key (required)
 *
 * Transport selection:
 *   ATLASENT_TRANSPORT=http  → HTTP/SSE transport
 *   (unset / anything else)  → stdio (default MCP transport)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AtlaSentApiClient } from './client.js';
import { loadConfig } from './config.js';

const VERSION = '2.0.0';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new AtlaSentApiClient(config.apiUrl, config.apiKey);

  const server = new McpServer({
    name: '@atlasent/mcp-server',
    version: VERSION,
  });

  // ---------------------------------------------------------------------------
  // evaluate_action — POST /v1/evaluate
  // ---------------------------------------------------------------------------
  server.registerTool(
    'evaluate_action',
    {
      title: 'AtlaSent — Evaluate Action',
      description:
        'Evaluate an action request against AtlaSent policies. Returns a decision ' +
        '(allow, deny, or require_approval) along with risk level and permit details.',
      inputSchema: z.object({
        action_id: z.string().describe('Action identifier to evaluate (e.g. ci.production-deploy)'),
        environment: z.string().optional().default('production').describe('Target environment'),
        actor_id: z.string().optional().describe('Actor identifier'),
        context: z.record(z.unknown()).optional().describe('Additional context key-value pairs'),
      }),
    },
    async (args) => {
      const body = {
        actor: { id: args.actor_id ?? 'unknown', type: 'user', org_id: '' },
        action: { id: args.action_id },
        environment: args.environment ?? 'production',
        context: args.context ?? {},
      };
      const result = await client.call('/v1/evaluate', 'POST', body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // get_session — GET /v1/session
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_session',
    {
      title: 'AtlaSent — Get Session',
      description: 'Retrieve the current API session details and org information.',
      inputSchema: z.object({}),
    },
    async () => {
      const result = await client.call('/v1/session');
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // list_audit_events — GET /v1/audit/events
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_audit_events',
    {
      title: 'AtlaSent — List Audit Events',
      description: 'List audit events for the organisation. Supports optional filtering.',
      inputSchema: z.object({
        limit: z.number().int().positive().optional().describe('Maximum number of events to return'),
        offset: z.number().int().nonnegative().optional().describe('Pagination offset'),
        actor_id: z.string().optional().describe('Filter by actor ID'),
        action_id: z.string().optional().describe('Filter by action ID'),
        environment: z.string().optional().describe('Filter by environment'),
      }),
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.limit != null) params.set('limit', String(args.limit));
      if (args.offset != null) params.set('offset', String(args.offset));
      if (args.actor_id) params.set('actor_id', args.actor_id);
      if (args.action_id) params.set('action_id', args.action_id);
      if (args.environment) params.set('environment', args.environment);
      const qs = params.toString();
      const result = await client.call(`/v1/audit/events${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // list_policies — GET /v1/policies
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_policies',
    {
      title: 'AtlaSent — List Policies',
      description: 'List all policies defined for the organisation.',
      inputSchema: z.object({
        limit: z.number().int().positive().optional().describe('Maximum number of policies to return'),
        offset: z.number().int().nonnegative().optional().describe('Pagination offset'),
      }),
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.limit != null) params.set('limit', String(args.limit));
      if (args.offset != null) params.set('offset', String(args.offset));
      const qs = params.toString();
      const result = await client.call(`/v1/policies${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // get_policy — GET /v1/policies/:id
  // ---------------------------------------------------------------------------
  server.registerTool(
    'get_policy',
    {
      title: 'AtlaSent — Get Policy',
      description: 'Retrieve a single policy by ID.',
      inputSchema: z.object({
        id: z.string().describe('Policy ID'),
      }),
    },
    async (args) => {
      const result = await client.call(`/v1/policies/${encodeURIComponent(args.id)}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // create_policy — POST /v1/policies
  // ---------------------------------------------------------------------------
  server.registerTool(
    'create_policy',
    {
      title: 'AtlaSent — Create Policy',
      description: 'Create a new policy. The policy is created in draft state.',
      inputSchema: z.object({
        name: z.string().describe('Human-readable policy name'),
        description: z.string().optional().describe('Policy description'),
        rules: z.array(z.record(z.unknown())).describe('Array of policy rule objects'),
        action_ids: z.array(z.string()).optional().describe('Action IDs this policy applies to'),
        environments: z.array(z.string()).optional().describe('Environments this policy applies to'),
      }),
    },
    async (args) => {
      const result = await client.call('/v1/policies', 'POST', args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // publish_policy — POST /v1/policies/:id/publish
  // ---------------------------------------------------------------------------
  server.registerTool(
    'publish_policy',
    {
      title: 'AtlaSent — Publish Policy',
      description: 'Publish a draft policy, making it active for evaluations.',
      inputSchema: z.object({
        id: z.string().describe('Policy ID to publish'),
      }),
    },
    async (args) => {
      const result = await client.call(`/v1/policies/${encodeURIComponent(args.id)}/publish`, 'POST');
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // list_approvals — GET /v1/approvals
  // ---------------------------------------------------------------------------
  server.registerTool(
    'list_approvals',
    {
      title: 'AtlaSent — List Approvals',
      description: 'List pending and resolved approval requests.',
      inputSchema: z.object({
        status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional().describe('Filter by approval status'),
        limit: z.number().int().positive().optional().describe('Maximum number of approvals to return'),
        offset: z.number().int().nonnegative().optional().describe('Pagination offset'),
      }),
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.status) params.set('status', args.status);
      if (args.limit != null) params.set('limit', String(args.limit));
      if (args.offset != null) params.set('offset', String(args.offset));
      const qs = params.toString();
      const result = await client.call(`/v1/approvals${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // resolve_approval — POST /v1/approvals/:id/resolve
  // ---------------------------------------------------------------------------
  server.registerTool(
    'resolve_approval',
    {
      title: 'AtlaSent — Resolve Approval',
      description: 'Approve or reject a pending approval request.',
      inputSchema: z.object({
        id: z.string().describe('Approval request ID'),
        resolution: z.enum(['approved', 'rejected']).describe('Resolution decision'),
        comment: z.string().optional().describe('Optional comment explaining the resolution'),
      }),
    },
    async (args) => {
      const body = {
        resolution: args.resolution,
        ...(args.comment ? { comment: args.comment } : {}),
      };
      const result = await client.call(`/v1/approvals/${encodeURIComponent(args.id)}/resolve`, 'POST', body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // request_override — POST /v1/overrides
  // ---------------------------------------------------------------------------
  server.registerTool(
    'request_override',
    {
      title: 'AtlaSent — Request Override',
      description:
        'Request an override for a denied action. Creates an override request that ' +
        'can be reviewed and approved by an authorised operator.',
      inputSchema: z.object({
        evaluation_id: z.string().describe('Evaluation ID of the denied action'),
        justification: z.string().describe('Business justification for the override'),
        requested_by: z.string().optional().describe('Identifier of the person requesting the override'),
      }),
    },
    async (args) => {
      const result = await client.call('/v1/overrides', 'POST', args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // Start server
  // ---------------------------------------------------------------------------
  const transport = (process.env.ATLASENT_TRANSPORT ?? '').toLowerCase();

  if (transport === 'http') {
    // Dynamically import HTTP transport to keep stdio startup lean.
    const { startHttpServer } = await import('./http-transport.js');
    await startHttpServer(server);
    await new Promise<void>(() => { /* intentionally never resolves */ });
  } else {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
