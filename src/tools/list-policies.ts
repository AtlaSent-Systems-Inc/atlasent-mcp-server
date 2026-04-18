import { z } from 'zod';

export const listPoliciesInputSchema = {
  pack: z.string().optional().describe('Filter by pack name (e.g. gxp, hipaa, soc2)'),
};

export type ListPoliciesInput = { pack?: string };

export async function listPoliciesHandler(
  input: ListPoliciesInput,
  fetchFn: (path: string, init?: RequestInit) => Promise<Response>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const qs = input.pack ? `?pack=${encodeURIComponent(input.pack)}` : '';
  const res = await fetchFn(`/v1/policies${qs}`);
  if (!res.ok) throw new Error(`AtlaSent /v1/policies: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
