import { z } from 'zod';

export const explainDenyInputSchema = {
  evaluation_id: z.string().describe('The evaluation ID returned by a previous evaluate call'),
};

export type ExplainDenyInput = { evaluation_id: string };

export async function explainDenyHandler(
  input: ExplainDenyInput,
  fetchFn: (path: string, init?: RequestInit) => Promise<Response>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const res = await fetchFn(`/v1/evaluations/${encodeURIComponent(input.evaluation_id)}`);
  if (!res.ok) throw new Error(`AtlaSent evaluation lookup: ${res.status} ${res.statusText}`);
  const d = await res.json() as {
    action?: string; decision?: string; timestamp?: string;
    matched_rule?: string; reason?: string; policy_clause?: string;
  };
  const lines = [
    `Evaluation ID : ${input.evaluation_id}`,
    `Action        : ${d.action ?? 'unknown'}`,
    `Decision      : ${d.decision ?? 'unknown'}`,
    `Timestamp     : ${d.timestamp ?? 'unknown'}`,
    `Matched rule  : ${d.matched_rule ?? 'unknown'}`,
    `Reason        : ${d.reason ?? 'no reason provided'}`,
    d.policy_clause ? `Policy clause :\n  ${d.policy_clause}` : '',
  ].filter(Boolean);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
