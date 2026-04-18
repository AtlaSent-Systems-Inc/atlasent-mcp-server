import { z } from 'zod';

export const simulateActionInputSchema = {
  action: z.string().describe('The action name to simulate (e.g. deploy_to_production)'),
  agent_id: z.string().optional().describe('Agent identifier'),
  context: z.record(z.unknown()).optional().describe('Context key-value pairs for policy evaluation'),
};

export type SimulateActionInput = {
  action: string;
  agent_id?: string;
  context?: Record<string, unknown>;
};

export async function simulateActionHandler(
  input: SimulateActionInput,
  fetchFn: (path: string, init?: RequestInit) => Promise<Response>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const res = await fetchFn('/v1/evaluate', {
    method: 'POST',
    body: JSON.stringify({
      action: input.action,
      agent_id: input.agent_id,
      context: input.context,
      dry_run: true,
    }),
  });
  if (!res.ok) throw new Error(`AtlaSent dry-run: ${res.status} ${res.statusText}`);
  const d = await res.json() as { decision: string; matched_rule?: string; reason?: string };
  return {
    content: [{
      type: 'text',
      text: [
        '[DRY RUN — not recorded to audit trail]',
        `Decision     : ${d.decision}`,
        `Matched rule : ${d.matched_rule ?? 'none'}`,
        `Reason       : ${d.reason ?? 'n/a'}`,
      ].join('\n'),
    }],
  };
}
