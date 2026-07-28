import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

const mockAnonSession = {
  access_token: 'anon-token',
  refresh_token: 'anon-refresh',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'anon-user', is_anonymous: true },
};

const mockAuthedSession = {
  access_token: 'authed-token',
  refresh_token: 'authed-refresh',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'authed-user', is_anonymous: false, email: 'me@example.com' },
};

jest.mock('@/observability/sentry', () => ({ setSentryUser: jest.fn() }));

jest.mock('@/supabase/config', () => ({
  getSupabaseConfigState: () => ({
    status: 'configured',
    config: { url: 'https://x.supabase.co', anonKey: 'anon' },
  }),
  describeSupabaseConfig: () => 'Configured from Expo public environment',
}));

jest.mock('@/supabase/client', () => {
  const actual = jest.requireActual('@/supabase/client');
  const client = {
    restoreSession: jest.fn(async () => ({ outcome: 'none' })),
    signInAnonymously: jest.fn(async () => mockAnonSession),
    signOut: jest.fn(async () => {}),
  };
  return {
    __client: client,
    createSupabaseClient: () => client,
    isSessionExpired: actual.isSessionExpired,
  };
});

jest.mock('@/supabase/run-oauth', () => ({
  runOAuthSignIn: jest.fn(async () => mockAuthedSession),
}));

import { SupabaseAuthProvider, useSupabaseAuth } from '@/supabase/auth-provider';

const { __client: fakeClient } = jest.requireMock('@/supabase/client') as {
  __client: { signOut: jest.Mock; signInAnonymously: jest.Mock; restoreSession: jest.Mock };
};
// Same client instance — aliased for readability where we assert on minting.
const fakeAnonClient = fakeClient;
const { runOAuthSignIn } = jest.requireMock('@/supabase/run-oauth') as {
  runOAuthSignIn: jest.Mock;
};

function wrapper({ children }: { children: ReactNode }) {
  return <SupabaseAuthProvider>{children}</SupabaseAuthProvider>;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('bootstraps an anonymous session on mount', async () => {
  const { result } = await renderHook(() => useSupabaseAuth(), { wrapper });

  await waitFor(() => expect(result.current.status).toBe('anonymous'));
  expect(result.current.isSignedIn).toBe(true);
  expect(result.current.email).toBeNull();
});

test('a REAL account whose session cannot be refreshed enters session_expired without minting anonymous', async () => {
  // The reported bug: a signed-in user whose refresh token was rejected on
  // launch got silently downgraded to a fresh anonymous user, which then made
  // the sync account-transition drop their local cache (empty "logged out"
  // Inbox). We must NOT mint anonymous here — keep the local data, prompt a
  // re-sign-in.
  fakeClient.restoreSession.mockResolvedValueOnce({ outcome: 'expired', wasAnonymous: false });

  const { result } = await renderHook(() => useSupabaseAuth(), { wrapper });

  await waitFor(() => expect(result.current.status).toBe('session_expired'));
  expect(result.current.session).toBeNull();
  expect(result.current.isSignedIn).toBe(false);
  // Crucially: NO anonymous user was minted (that is what dropped the cache).
  expect(fakeAnonClient.signInAnonymously).not.toHaveBeenCalled();
});

test('an ANONYMOUS session that lapses still mints a fresh anonymous user (data carries over)', async () => {
  fakeClient.restoreSession.mockResolvedValueOnce({ outcome: 'expired', wasAnonymous: true });

  const { result } = await renderHook(() => useSupabaseAuth(), { wrapper });

  await waitFor(() => expect(result.current.status).toBe('anonymous'));
  expect(result.current.isSignedIn).toBe(true);
  expect(fakeAnonClient.signInAnonymously).toHaveBeenCalledTimes(1);
});

test('signIn links the anonymous user and becomes authenticated', async () => {
  const { result } = await renderHook(() => useSupabaseAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('anonymous'));

  await act(async () => {
    await result.current.signIn('google');
  });

  // Linked: the anonymous access token was passed so data carries over.
  expect(runOAuthSignIn).toHaveBeenCalledWith('google', {
    currentAccessToken: mockAnonSession.access_token,
  });
  expect(result.current.status).toBe('authenticated');
  expect(result.current.email).toBe('me@example.com');
  expect(result.current.isSignedIn).toBe(true);
});

test('signOut revokes the session and drops to signed_out without minting a new anonymous user', async () => {
  const { result } = await renderHook(() => useSupabaseAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('anonymous'));

  await act(async () => {
    await result.current.signIn('apple');
  });
  await waitFor(() => expect(result.current.status).toBe('authenticated'));

  // One anonymous mint so far: the mount bootstrap.
  expect(fakeAnonClient.signInAnonymously).toHaveBeenCalledTimes(1);

  await act(async () => {
    await result.current.signOut();
  });

  // Best-effort server revoke still happens.
  expect(fakeClient.signOut).toHaveBeenCalledWith(mockAuthedSession.access_token);
  // Lazy logout: signed_out, no session, no new anonymous user minted.
  await waitFor(() => expect(result.current.status).toBe('signed_out'));
  expect(result.current.session).toBeNull();
  expect(result.current.isSignedIn).toBe(false);
  expect(result.current.email).toBeNull();
  // Crucially, NO additional anonymous user was created on logout.
  expect(fakeAnonClient.signInAnonymously).toHaveBeenCalledTimes(1);
});

test('repeated ensureAnonymousSession calls with a live, status-matching session do not flicker status through loading (Sentry STASH-3D)', async () => {
  // The reported bug: during a large sync, many independent call sites (each
  // auto AI-enrichment dispatch, every sync pass) call ensureAnonymousSession
  // repeatedly. With a still-valid, status-matching session in hand, a
  // redundant call must settle without ever bouncing `status` through
  // `loading` — that flip flickered the signed-in/signed-out UI. It still
  // consults restoreSession (so shared/cross-tab storage stays authoritative
  // — see the web multi-tab test below), which itself resolves without a
  // network round trip when the stored session is still valid.
  const statuses: string[] = [];
  const { result } = await renderHook(
    () => {
      const auth = useSupabaseAuth();
      statuses.push(auth.status);
      return auth;
    },
    { wrapper },
  );
  await waitFor(() => expect(result.current.status).toBe('anonymous'));
  statuses.length = 0;

  fakeClient.restoreSession.mockClear();
  fakeClient.restoreSession.mockResolvedValueOnce({ outcome: 'active', session: mockAnonSession });

  await act(async () => {
    const resolved = await result.current.ensureAnonymousSession();
    expect(resolved?.access_token).toBe(mockAnonSession.access_token);
  });

  // restoreSession(false) was called (no forced refresh), and any re-render
  // along the way (e.g. from the `message` copy changing) never observed
  // `status` as anything but `anonymous` — no `loading` flicker.
  expect(fakeClient.restoreSession).toHaveBeenLastCalledWith(false);
  expect(statuses).not.toContain('loading');
  expect(result.current.status).toBe('anonymous');
});

test('a failed forced refresh does not get masked by the fast path on the next call', async () => {
  // Codex review on the fix above: a forced refresh (e.g. after a 401) that
  // fails on a transient network error sets `status` to `error` WITHOUT
  // clearing the still locally-unexpired session. A later non-forced call
  // must notice the status/session mismatch and force a REAL refresh — not
  // silently re-serve the same server-rejected token via restoreSession's
  // own "not locally expired" fast path, which would leave `status` stuck
  // on `error` (Settings shows sign-in, background sync stays disabled)
  // until the token's local expiry margin elapses or the app restarts.
  const { result } = await renderHook(() => useSupabaseAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('anonymous'));

  fakeClient.restoreSession.mockRejectedValueOnce(new Error('network down'));
  await act(async () => {
    const resolved = await result.current.ensureAnonymousSession(true);
    expect(resolved).toBeNull();
  });
  expect(result.current.status).toBe('error');
  // The session itself is untouched by the failed forced refresh — it still
  // looks locally unexpired, which is exactly what could mask the bad status.
  expect(result.current.session?.access_token).toBe(mockAnonSession.access_token);

  fakeClient.restoreSession.mockClear();
  fakeClient.restoreSession.mockResolvedValueOnce({ outcome: 'active', session: mockAnonSession });
  await act(async () => {
    await result.current.ensureAnonymousSession();
  });

  // The status/session mismatch forced a real refresh attempt (not a plain
  // restore that would've just re-served the same bad token) and recovered.
  expect(fakeClient.restoreSession).toHaveBeenLastCalledWith(true);
  expect(result.current.status).toBe('anonymous');
});

test('a background browser tab reconciles a session another tab wrote to shared storage (Codex review, web multi-tab)', async () => {
  // Web sessions are shared via localStorage across same-origin tabs. If tab
  // A signs into a different account, tab B's still-unexpired in-memory
  // session must not be handed back unconditionally — that would let tab B
  // keep syncing under the stale identity until token expiry or reload.
  const { result } = await renderHook(() => useSupabaseAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('anonymous'));

  fakeClient.restoreSession.mockClear();
  // Simulates another tab having signed into a real account: storage now
  // holds a different, authenticated session even though this tab's cached
  // anonymous session still looks locally unexpired.
  fakeClient.restoreSession.mockResolvedValueOnce({ outcome: 'active', session: mockAuthedSession });

  await act(async () => {
    const resolved = await result.current.ensureAnonymousSession();
    expect(resolved?.access_token).toBe(mockAuthedSession.access_token);
  });

  // Consulted storage (not forced — this isn't the stale-token-mismatch
  // case, just an ordinary redundant call) and picked up the other tab's
  // session instead of silently keeping the stale in-memory one.
  expect(fakeClient.restoreSession).toHaveBeenLastCalledWith(false);
  expect(result.current.status).toBe('authenticated');
  expect(result.current.session?.access_token).toBe(mockAuthedSession.access_token);
});

test('a save after logout lazily mints an anonymous session', async () => {
  const { result } = await renderHook(() => useSupabaseAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('anonymous'));

  await act(async () => {
    await result.current.signIn('apple');
  });
  await waitFor(() => expect(result.current.status).toBe('authenticated'));

  await act(async () => {
    await result.current.signOut();
  });
  await waitFor(() => expect(result.current.status).toBe('signed_out'));

  // The store/sync path calls ensureAnonymousSession() on the first save — it
  // must be able to run from the signed_out state and mint a fresh anonymous
  // user (the inFlight guard was reset on logout).
  await act(async () => {
    await result.current.ensureAnonymousSession();
  });

  await waitFor(() => expect(result.current.status).toBe('anonymous'));
  expect(result.current.isSignedIn).toBe(true);
  // Mount bootstrap + this lazy mint = two anonymous creations total.
  expect(fakeAnonClient.signInAnonymously).toHaveBeenCalledTimes(2);
});
