export interface ServerConfig {
  apiUrl: string;
  apiKey: string;
  orgId?: string;
  timeout?: number;
}

export function loadConfig(): ServerConfig {
  const apiUrl = process.env.ATLASENT_API_URL;
  const apiKey = process.env.ATLASENT_API_KEY;
  if (!apiUrl) throw new Error('ATLASENT_API_URL environment variable is required');
  if (!apiKey) throw new Error('ATLASENT_API_KEY environment variable is required');
  return { apiUrl, apiKey, orgId: process.env.ATLASENT_ORG_ID, timeout: Number(process.env.ATLASENT_TIMEOUT ?? 10_000) };
}

export async function apiRequest<T>(config: ServerConfig, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.apiUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-AtlaSent-Key': config.apiKey, ...init.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`${err.code ?? 'api_error'}: ${err.message ?? 'Request failed'} (${res.status})`);
  }
  return res.json();
}
