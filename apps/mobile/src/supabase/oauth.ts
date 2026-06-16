/**
 * Pure helpers for the OAuth (PKCE) sign-in flow.
 *
 * This module is intentionally dependency-free (no Expo/native imports) so it
 * runs under the Node test runner and can be reused by the verify scripts. The
 * side-effecting parts of the flow — random bytes, SHA-256, opening a browser —
 * live in `run-oauth.ts`, which is only loaded on device/at runtime.
 */

import type { OAuthProvider } from '@/supabase/types';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 of a byte array (no external `btoa` dependency). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = hasB1 ? bytes[i + 1]! : 0;
    const b2 = hasB2 ? bytes[i + 2]! : 0;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += hasB1 ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += hasB2 ? BASE64_ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

/** Convert standard base64 to the URL-safe, unpadded form RFC 7636 expects. */
export function base64ToBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url-encode raw bytes (used to build the PKCE code verifier). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return base64ToBase64Url(bytesToBase64(bytes));
}

export interface AuthorizeOptions {
  provider: OAuthProvider;
  /** Where the provider redirects back to once consent completes. */
  redirectTo: string;
  /** PKCE code challenge (base64url of SHA-256 of the verifier). */
  codeChallenge: string;
  /** Extra provider scopes, space-separated. */
  scopes?: string;
  /**
   * When true, ask GoTrue to return the authorize URL as JSON instead of a 302.
   * Used for the authenticated identity-linking call.
   */
  skipHttpRedirect?: boolean;
}

/** Build the `provider=…&redirect_to=…` query string for `/auth/v1/authorize`. */
export function buildAuthorizeQuery(opts: AuthorizeOptions): string {
  const parts = [
    `provider=${encodeURIComponent(opts.provider)}`,
    `redirect_to=${encodeURIComponent(opts.redirectTo)}`,
    `code_challenge=${encodeURIComponent(opts.codeChallenge)}`,
    'code_challenge_method=s256',
  ];
  if (opts.scopes) {
    parts.push(`scopes=${encodeURIComponent(opts.scopes)}`);
  }
  if (opts.skipHttpRedirect) {
    parts.push('skip_http_redirect=true');
  }
  return parts.join('&');
}

/** Full hosted authorize URL the browser opens for a fresh sign-in. */
export function buildAuthorizeUrl(supabaseUrl: string, opts: AuthorizeOptions): string {
  return `${supabaseUrl.replace(/\/$/, '')}/auth/v1/authorize?${buildAuthorizeQuery(opts)}`;
}

export interface AuthRedirectResult {
  code: string | null;
  error: string | null;
  errorDescription: string | null;
}

/**
 * Pull the PKCE `code` (or an `error`) out of the URL the provider redirects
 * back to. Parses both `?query` and `#fragment` forms without relying on the
 * `URL` global, which is unevenly polyfilled across React Native runtimes.
 */
export function parseAuthRedirect(url: string): AuthRedirectResult {
  const separators = ['?', '#']
    .map((char) => url.indexOf(char))
    .filter((index) => index >= 0);
  const start = separators.length > 0 ? Math.min(...separators) : -1;
  const query = start >= 0 ? url.slice(start + 1) : '';

  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair) {
      continue;
    }
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1).replace(/\+/g, ' ');
    try {
      params.set(decodeURIComponent(rawKey), decodeURIComponent(rawValue));
    } catch {
      params.set(rawKey, rawValue);
    }
  }

  return {
    code: params.get('code') ?? null,
    error: params.get('error') ?? null,
    errorDescription: params.get('error_description') ?? null,
  };
}
