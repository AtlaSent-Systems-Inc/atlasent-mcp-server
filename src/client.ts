export class AtlaSentApiClient {
  constructor(private apiUrl: string, private apiKey: string) {}

  async call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-AtlaSent-Key': this.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json();
  }
}
