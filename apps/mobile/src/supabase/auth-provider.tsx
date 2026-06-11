import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { describeSupabaseConfig, getSupabaseConfigState } from '@/supabase/config';
import { createSupabaseClient } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';

export type SupabaseAuthStatus = 'not_configured' | 'loading' | 'anonymous' | 'error';

interface SupabaseAuthContextValue {
  status: SupabaseAuthStatus;
  session: SupabaseAuthSession | null;
  userId: string | null;
  message: string;
  ensureAnonymousSession: () => Promise<SupabaseAuthSession | null>;
}

const SupabaseAuthContext = createContext<SupabaseAuthContextValue | null>(null);

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Supabase auth failed.';
}

export function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  const configState = useMemo(() => getSupabaseConfigState(), []);
  const [status, setStatus] = useState<SupabaseAuthStatus>(
    configState.status === 'missing' ? 'not_configured' : 'loading',
  );
  const [session, setSession] = useState<SupabaseAuthSession | null>(null);
  const [message, setMessage] = useState(() => describeSupabaseConfig(configState));

  const ensureAnonymousSession = useCallback(async (): Promise<SupabaseAuthSession | null> => {
    if (configState.status === 'missing') {
      setStatus('not_configured');
      setMessage(describeSupabaseConfig(configState));
      return null;
    }

    setStatus('loading');
    const client = createSupabaseClient();
    try {
      const restored = await client.restoreSession();
      if (restored) {
        setSession(restored);
        setStatus('anonymous');
        setMessage('Restored anonymous Supabase session.');
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
    }
  }, [configState]);

  useEffect(() => {
    void ensureAnonymousSession();
  }, [ensureAnonymousSession]);

  const value = useMemo<SupabaseAuthContextValue>(
    () => ({
      status,
      session,
      userId: session?.user.id ?? null,
      message,
      ensureAnonymousSession,
    }),
    [status, session, message, ensureAnonymousSession],
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
