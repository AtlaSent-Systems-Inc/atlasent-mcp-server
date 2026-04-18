export function loadConfig() {
  return {
    apiUrl: process.env.ATLASENT_API_URL ?? 'https://api.atlasent.io',
    apiKey: process.env.ATLASENT_API_KEY ?? '',
  };
}
