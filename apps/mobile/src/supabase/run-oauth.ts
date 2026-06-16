/**
 * Runtime OAuth (PKCE) sign-in flow. This is the only auth file that imports
 * native/Expo modules (crypto, web browser, linking), so it is kept apart from
 * the pure helpers in `oauth.ts` and the network-only `client.ts` — both of
 * which must stay loadable under the Node test runner and verify scripts.
 */

import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { createSupabaseClient } from '@/supabase/client';
import { getSupabaseConfigState } from '@/supabase/config';
import {
  base64ToBase64Url,
  buildAuthorizeUrl,
  bytesToBase64Url,
  parseAuthRedirect,
} from '@/supabase/oauth';
import type { OAuthProvider, SupabaseAuthSession } from '@/supabase/types';

// Required on web so the redirect tab can hand the result back to the opener.
WebBrowser.maybeCompleteAuthSession();

const REDIRECT_PATH = 'auth/callback';

interface RunOAuthOptions {
  /**
   * When provided, the new identity is linked to this (anonymous) user so the
   * account upgrade preserves existing bookmarks. Omit for a plain sign-in.
   */
  currentAccessToken?: string;
}

/**
 * Drives a provider sign-in end to end: builds a PKCE challenge, opens the
 * hosted consent page, and exchanges the returned code for a session.
 *
 * Resolves to the new session, or `null` when the user dismisses the browser
 * (a cancel, not an error). Throws when the provider or token exchange fails.
 */
export async function runOAuthSignIn(
  provider: OAuthProvider,
  options: RunOAuthOptions = {},
): Promise<SupabaseAuthSession | null> {
  const state = getSupabaseConfigState();
  if (state.status === 'missing') {
    return null;
  }

  const client = createSupabaseClient();
  const redirectTo = Linking.createURL(REDIRECT_PATH);

  // PKCE: a high-entropy verifier kept on-device, and its SHA-256 sent up front.
  const codeVerifier = bytesToBase64Url(Crypto.getRandomBytes(32));
  const challengeBase64 = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    codeVerifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  const codeChallenge = base64ToBase64Url(challengeBase64);

  let authUrl: string;
  if (options.currentAccessToken) {
    try {
      authUrl = await client.requestOAuthLinkUrl({
        provider,
        redirectTo,
        codeChallenge,
        accessToken: options.currentAccessToken,
      });
    } catch {
      // Linking can be disabled on the project (or the identity already belongs
      // to another user). Fall back to a normal sign-in rather than failing.
      authUrl = buildAuthorizeUrl(state.config.url, { provider, redirectTo, codeChallenge });
    }
  } else {
    authUrl = buildAuthorizeUrl(state.config.url, { provider, redirectTo, codeChallenge });
  }

  const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectTo);
  if (result.type !== 'success' || !result.url) {
    return null; // dismissed / cancelled
  }

  const redirect = parseAuthRedirect(result.url);
  if (redirect.error) {
    throw new Error(redirect.errorDescription ?? redirect.error);
  }
  if (!redirect.code) {
    throw new Error('OAuth provider did not return an authorization code.');
  }

  return client.exchangeCodeForSession(redirect.code, codeVerifier);
}
