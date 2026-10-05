export const PRIVATE_IMAGE_URL_TTL_SECONDS = 300;

export type ImageReference =
  | { kind: 'external' }
  | { kind: 'blocked' }
  | { kind: 'private'; path: string };

/** Recognize old public references and new authenticated references without
 * ever sending a session to an arbitrary image host or signing another owner. */
export function privateImageReference(uri: string, projectUrl: string, userId: string | null): ImageReference {
  let url: URL;
  try { url = new URL(uri); } catch { return { kind: 'external' }; }
  const prefix = /^\/storage\/v1\/object\/(?:public|authenticated|sign)\/bookmark-images\/(.*)$/;
  const match = prefix.exec(url.pathname);
  if (!match) return { kind: 'external' };
  let origin: string;
  try { origin = new URL(projectUrl).origin; } catch { return { kind: 'blocked' }; }
  if (url.origin !== origin || url.username || url.password || !userId) return { kind: 'blocked' };
  let path: string;
  try { path = decodeURIComponent(match[1]); } catch { return { kind: 'blocked' }; }
  const parts = path.split('/');
  if (parts.length !== 2 || parts[0] !== userId || !parts[1] || parts.some((part) => part === '.' || part === '..')) {
    return { kind: 'blocked' };
  }
  return { kind: 'private', path };
}

export function signedImageUrl(projectUrl: string, path: string, response: unknown): string {
  const value = response && typeof response === 'object' ? (response as { signedURL?: unknown }).signedURL : null;
  if (typeof value !== 'string') throw new Error('Invalid signed image response');
  const base = new URL(projectUrl);
  const candidate = value.startsWith('/object/') ? `/storage/v1${value}` : value;
  const result = new URL(candidate, base);
  const expectedPath = `/storage/v1/object/sign/bookmark-images/${path.split('/').map(encodeURIComponent).join('/')}`;
  if (result.origin !== base.origin || result.pathname !== expectedPath || !result.searchParams.get('token') || result.username || result.password) {
    throw new Error('Invalid signed image URL');
  }
  return result.toString();
}
