import { previewFetch } from '@/domain/preview-fetch';

/** Admission for automatic previews, not for storing or opening a bookmark.
 * This cannot resolve/pin DNS or repair runtimes that ignore manual redirects.
 * Full network isolation still requires a resolver-aware preview service.
 */
export function isPublicPreviewUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (url.port && !['80', '443'].includes(url.port)) return false;
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    // Reject all IPv6 literals, including mapped IPv4 and NAT64 encodings.
    if (host.includes(':') || !host.includes('.')) return false;
    if (/\.(localhost|local|localdomain|internal|lan|home|test|invalid|onion)$/.test(host) || host.endsWith('.home.arpa')) return false;
    // Some native URL implementations do not canonicalize legacy IP notation.
    // Reject it rather than let the OS resolver interpret a different address.
    if (/^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*$/i.test(host) &&
        (host.split('.').length !== 4 || host.split('.').some((part) => !/^(0|[1-9]\d*)$/.test(part) || Number(part) > 255))) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b, c] = host.split('.').map(Number);
      // URL parsing canonicalizes decimal/octal/hex and shortened IPv4 forms.
      if (a === 0 || a === 10 || a === 127 || a >= 224 ||
          (a === 100 && b >= 64 && b <= 127) ||
          (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && (b === 168 || b === 0 || (b === 2))) ||
          (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
          (a === 203 && b === 0 && c === 113)) return false;
    }
    return true;
  } catch { return false; }
}

/** Validate every observable redirect before sending the next request. */
export async function fetchPublicPreview(
  raw: string,
  init: RequestInit = {},
  fetcher: typeof fetch = previewFetch as typeof fetch,
): Promise<Response> {
  let target = raw;
  const visited = new Set<string>();
  for (let hop = 0; hop <= 5; hop += 1) {
    if (!isPublicPreviewUrl(target) || visited.has(target)) throw new Error('Unsafe preview target');
    visited.add(target);
    const response = await fetcher(target, { ...init, redirect: 'manual', credentials: 'omit' });
    if (response.type === 'opaqueredirect') throw new Error('Preview redirect is not inspectable');
    if (response.url && !isPublicPreviewUrl(response.url)) {
      await response.body?.cancel();
      throw new Error('Unsafe preview response URL');
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || hop === 5) throw new Error('Preview redirect limit');
    target = new URL(location, target).toString();
  }
  throw new Error('Preview redirect limit');
}
