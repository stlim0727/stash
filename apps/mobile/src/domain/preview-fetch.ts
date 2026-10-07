export function previewFetch(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init);
}
