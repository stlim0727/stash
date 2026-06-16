import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { setSentryUser } from '@/observability/sentry';
import { describeSupabaseConfig, getSupabaseConfigState } from '@/supabase/config';
import { createSupabaseClient } from '@/supabase/client';
import { runOAuthSignIn } from '@/supabase/run-oauth';
import type { OAuthProvider, SupabaseAuthSession } from '@/supabase/types';

export type SupabaseAuthStatus =
  | 'not_configured'
  | 'loading'
  | 'anonymous'
  | 'authenticated'
  | 'error';

interface SupabaseAuthContextValue {
  status: SupabaseAuthStatus;
  session: SupabaseAuthSession | null;
  userId: string | null;
  /** Email of the signed-in (non-anonymous) user, if any. */
  email: string | null;
  /** Display name from the OAuth profile, if the provider shared one. */
  displayName: string | null;
  /** Avatar image URL from the OAuth profile, if the provider shared one. */
  avatarUrl: string | null;
  /** True when a usable session exists (anonymous OR authenticated). */
  isSignedIn: boolean;
  message: string;
  ensureAnonymousSession: () => Promise<SupabaseAuthSession | null>;
  /** Start an OAuth sign-in; links the anonymous account in place when possible. */
  signIn: (provider: OAuthProvider) => Promise<SupabaseAuthSession | null>;
  /** Sign out and fall back to a fresh anonymous session (anonymous-first). */
  signOut: () => Promise<void>;
}

const SupabaseAuthContext = createContext<SupabaseAuthContextValue | null>(null);

const PROVIDER_LABELS: Record<OAuthProvider, string> = {
  apple: 'Apple',
  google: 'Google',
};

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Supabase auth failed.';
}

/** A session belongs to a permanent account unless it is explicitly anonymous. */
function statusForSession(session: SupabaseAuthSession): 'anonymous' | 'authenticated' {
  return session.user.is_anonymous === false ? 'authenticated' : 'anonymous';
}

export function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  const configState = useMemo(() => getSupabaseConfigState(), []);
  const [status, setStatus] = useState<SupabaseAuthStatus>(
    configState.status === 'missing' ? 'not_configured' : 'loading',
  );
  const [session, setSession] = useState<SupabaseAuthSession | null>(null);
  const [message, setMessage] = useState(() => describeSupabaseConfig(configState));

  // Single-flight: concurrent callers (e.g. React StrictMode double-running
  // the mount effect) must not race past the restore check and create two
  // anonymous users.
  const inFlight = useRef<Promise<SupabaseAuthSession | null> | null>(null);

  const ensureAnonymousSession = useCallback((): Promise<SupabaseAuthSession | null> => {
    if (configState.status === 'missing') {
      setStatus('not_configured');
      setMessage(describeSupabaseConfig(configState));
      return Promise.resolve(null);
    }

    if (inFlight.current) {
      return inFlight.current;
    }

    setStatus('loading');
    const client = createSupabaseClient();
    const run = (async (): Promise<SupabaseAuthSession | null> => {
      try {
        const restored = await client.restoreSession();
        if (restored) {
          setSession(restored);
          setStatus(statusForSession(restored));
          setMessage(
            restored.user.is_anonymous === false
              ? 'Restored Supabase session.'
              : 'Restored anonymous Supabase session.',
          );
          return restored;
        }

        const created = await client.signInAnonymously();
        setSession(created);
        setStatus('anonymous');
        setMessage('Created anonymous Supabase session.');
        return created;
      } catch (error) {
        setStatus('error');
        setMessage(formatError(error));
        return null;
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, [configState]);

  const signIn = useCallback(
    async (provider: OAuthProvider): Promise<SupabaseAuthSession | null> => {
      if (configState.status === 'missing') {
        setStatus('not_configured');
        setMessage(describeSupabaseConfig(configState));
        return null;
      }

      try {
        // Link to the current anonymous user when there is one, so existing
        // bookmarks carry over to the new permanent account.
        const linkToken =
          session && session.user.is_anonymous !== false ? session.access_token : undefined;
        const next = await runOAuthSignIn(provider, { currentAccessToken: linkToken });
        if (!next) {
          return null; // user cancelled the browser flow
        }
        setSession(next);
        setStatus('authenticated');
        setMessage(`Signed in with ${PROVIDER_LABELS[provider]}.`);
        return next;
      } catch (error) {
        setMessage(formatError(error));
        throw error;
      }
    },
    [configState, session],
  );

  const signOut = useCallback(async (): Promise<void> => {
    const token = session?.access_token;
    try {
      if (token) {
        await createSupabaseClient().signOut(token);
      }
    } catch {
      // Best-effort: drop to a clean local state regardless.
    }
    setSession(null);
    setStatus(configState.status === 'missing' ? 'not_configured' : 'loading');
    setMessage('Signed out.');
    // Re-establish anonymous-first sync under a fresh local user.
    inFlight.current = null;
    await ensureAnonymousSession();
  }, [session, configState, ensureAnonymousSession]);

  useEffect(() => {
    void ensureAnonymousSession();
  }, [ensureAnonymousSession]);

  // Tag crash/error reports with the anonymous user id (opaque — no PII) so
  // events can be grouped per device. No-op until Sentry is configured.
  const userId = session?.user.id ?? null;
  useEffect(() => {
    setSentryUser(userId);
  }, [userId]);

  const email = session?.user.email ?? null;
  const metadata = session?.user.user_metadata;
  const displayName = metadata?.full_name ?? metadata?.name ?? null;
  const avatarUrl = metadata?.avatar_url ?? metadata?.picture ?? null;
  const isSignedIn = session !== null && (status === 'anonymous' || status === 'authenticated');

  const value = useMemo<SupabaseAuthContextValue>(
    () => ({
      status,
      session,
      userId,
      email,
      displayName,
      avatarUrl,
      isSignedIn,
      message,
      ensureAnonymousSession,
      signIn,
      signOut,
    }),
    [
      status,
      session,
      userId,
      email,
      displayName,
      avatarUrl,
      isSignedIn,
      message,
      ensureAnonymousSession,
      signIn,
      signOut,
    ],
  );

  return <SupabaseAuthContext.Provider value={value}>{children}</SupabaseAuthContext.Provider>;
}

export function useSupabaseAuth() {
  const context = useContext(SupabaseAuthContext);
  if (!context) {
    throw new Error('useSupabaseAuth must be used within a SupabaseAuthProvider');
  }

  return context;
}
