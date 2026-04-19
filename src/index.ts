#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { loadConfig, apiRequest } from './config.js';

const config = loadConfig();

const server = new Server(
  { name: 'atlasent-mcp-server', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

const tools = [
  {
    name: 'evaluate_action',
    description: 'Evaluate whether an action is allowed under active AtlaSent policies. Returns decision (allow/deny/require_approval), risk level, and permit ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        actor_id: { type: 'string', description: 'ID of the actor performing the action' },
        actor_type: { type: 'string', enum: ['user', 'service', 'agent', 'system'], default: 'agent' },
        action_type: { type: 'string', description: 'Type of action e.g. data:read, model:invoke, tool:execute' },
        target_id: { type: 'string', description: 'ID of the resource being acted upon' },
        target_type: { type: 'string', description: 'Type of target resource' },
        environment: { type: 'string', enum: ['production', 'staging', 'development'], default: 'production' },
      },
      required: ['actor_id', 'action_type', 'target_id'],
    },
  },
  {
    name: 'get_session',
    description: 'Get the current API key session details including permissions and role.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_audit_events',
    description: 'List audit events with optional filters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', default: 20 },
        type: { type: 'string' },
        actor_id: { type: 'string' },
        from: { type: 'string', description: 'ISO 8601 start date' },
        to: { type: 'string', description: 'ISO 8601 end date' },
      },
    },
  },
  {
    name: 'list_policies',
    description: 'List all policies in the organization.',
    inputSchema: { type: 'object' as const, properties: { status: { type: 'string', enum: ['draft', 'in_review', 'active', 'archived'] } } },
  },
  {
    name: 'get_policy',
    description: 'Get details of a specific policy including its rules.',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_approvals',
    description: 'List approval requests, optionally filtered by status.',
    inputSchema: { type: 'object' as const, properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired'] } } },
  },
  {
    name: 'resolve_approval',
    description: 'Approve or reject a pending approval request.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' },
        approved: { type: 'boolean' },
        review_note: { type: 'string' },
      },
      required: ['id', 'approved'],
    },
  },
  {
    name: 'verify_permit',
    description: 'Verify that a permit is still valid and active.',
    inputSchema: { type: 'object' as const, properties: { permit_id: { type: 'string' } }, required: ['permit_id'] },
  },
  {
    name: 'consume_permit',
    description: 'Consume (use up) a permit, marking it as used.',
    inputSchema: { type: 'object' as const, properties: { permit_id: { type: 'string' } }, required: ['permit_id'] },
  },
  {
    name: 'get_report',
    description: 'Get governance summary report for a time range.',
    inputSchema: { type: 'object' as const, properties: { days: { type: 'number', default: 7 } } },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    let result: unknown;

    switch (name) {
      case 'evaluate_action':
        result = await apiRequest(config, '/v1/evaluate', {
          method: 'POST',
          body: JSON.stringify({
            actor: { id: a.actor_id, type: a.actor_type ?? 'agent' },
            action: { id: randomUUID(), type: a.action_type },
            target: { id: a.target_id, type: a.target_type ?? 'resource', environment: a.environment ?? 'production' },
          }),
        });
        break;
      case 'get_session':
        result = await apiRequest(config, '/v1/session');
        break;
      case 'list_audit_events': {
        const p = new URLSearchParams();
        if (a.limit) p.set('limit', String(a.limit));
        if (a.type) p.set('type', String(a.type));
        if (a.actor_id) p.set('actor_id', String(a.actor_id));
        if (a.from) p.set('from', String(a.from));
        if (a.to) p.set('to', String(a.to));
        result = await apiRequest(config, `/v1/audit/events?${p}`);
        break;
      }
      case 'list_policies': {
        const p = new URLSearchParams();
        if (a.status) p.set('status', String(a.status));
        result = await apiRequest(config, `/v1/policies?${p}`);
        break;
      }
      case 'get_policy':
        result = await apiRequest(config, `/v1/policies/${a.id}`);
        break;
      case 'list_approvals': {
        const p = new URLSearchParams();
        if (a.status) p.set('status', String(a.status));
        result = await apiRequest(config, `/v1/approvals?${p}`);
        break;
      }
      case 'resolve_approval':
        result = await apiRequest(config, `/v1/approvals/${a.id}/resolve`, {
          method: 'POST',
          body: JSON.stringify({ approved: a.approved, reviewNote: a.review_note }),
        });
        break;
      case 'verify_permit':
        result = await apiRequest(config, `/v1/permits/${a.permit_id}/verify`, { method: 'POST' });
        break;
      case 'consume_permit':
        result = await apiRequest(config, `/v1/permits/${a.permit_id}/consume`, { method: 'POST' });
        break;
      case 'get_report': {
        const p = new URLSearchParams({ days: String(a.days ?? 7) });
        result = await apiRequest(config, `/v1/reports?${p}`);
        break;
      }
      default:
        return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: unknown) {
    return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
