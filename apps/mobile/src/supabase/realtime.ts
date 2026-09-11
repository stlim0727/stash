import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { RealtimeClient, RealtimeChannel } from '@supabase/realtime-js';
import type { SupabaseAuthSession } from '@/supabase/types';
import type { SupabaseAuthStatus } from '@/supabase/auth-provider';
import { getSupabaseConfigState } from '@/supabase/config';
import { repository } from '@/storage/repository';
import { recordLog } from '@/observability/log-buffer';

interface RealtimeSyncProps {
  session: SupabaseAuthSession | null;
  status: SupabaseAuthStatus;
  userId: string | null;
  syncNow: () => Promise<boolean>;
}

// A burst of near-simultaneous sync completions (e.g. a backlog draining in
// small chunks) must collapse to a single outbound nudge — the receiving
// side already debounces incoming nudges by 3s (see triggerDebouncedSync
// below), so sending the same "something changed" signal repeatedly within
// a much shorter window adds no information. It does have a real cost: when
// the channel can't push over the websocket, every send() falls back to an
// actual REST POST (Sentry STASH-5S: ~90 of these fired within 7s on one
// session, competing with the real pull/sync network traffic on a page that
// was already stuck loading).
const NUDGE_SEND_DEBOUNCE_MS = 1000;

export function useRealtimeSync({ session, status, userId, syncNow }: RealtimeSyncProps) {
  // A primitive, not the `session` object — see the comment on connectSocket's
  // dependency array below for why that distinction matters.
  const accessToken = session?.access_token ?? null;
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const rtClientRef = useRef<RealtimeClient | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const nudgeSendTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // `syncNow` is a useCallback keyed on the store's `auth`/`queue` state, so it
  // gets a new identity on essentially every sync-driven state change. Reading
  // it through a ref (reassigned every render, not a dependency) keeps
  // `triggerDebouncedSync`/`connectSocket` stable across those churns — see
  // the comment on the lifecycle effect below for why that matters.
  const syncNowRef = useRef(syncNow);
  syncNowRef.current = syncNow;

  // Retrieve or generate install_device_id
  useEffect(() => {
    let active = true;
    void repository.getMeta('install_device_id').then((stored) => {
      if (!active) return;
      if (stored) {
        setDeviceId(stored);
      } else {
        const newId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
          const rand = (Math.random() * 16) | 0;
          return (char === 'x' ? rand : (rand & 0x3) | 0x8).toString(16);
        });
        void repository.setMeta('install_device_id', newId).then(() => {
          if (active) setDeviceId(newId);
        });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const triggerDebouncedSync = useCallback(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    debounceTimeoutRef.current = setTimeout(() => {
      void syncNowRef.current().catch((err) => recordLog('warn', `Realtime sync failed: ${String(err)}`));
    }, 3000);
  }, []);

  const disconnectSocket = useCallback(() => {
    if (nudgeSendTimeoutRef.current) {
      clearTimeout(nudgeSendTimeoutRef.current);
      nudgeSendTimeoutRef.current = null;
    }
    if (channelRef.current) {
      channelRef.current.unsubscribe();
      channelRef.current = null;
    }
    if (rtClientRef.current) {
      rtClientRef.current.disconnect();
      rtClientRef.current = null;
    }
  }, []);

  const connectSocket = useCallback(() => {
    if (status !== 'authenticated' || !accessToken || !userId || AppState.currentState !== 'active') {
      disconnectSocket();
      return;
    }

    if (rtClientRef.current) {
      rtClientRef.current.setAuth(accessToken);
      return;
    }

    const configState = getSupabaseConfigState();
    if (configState.status !== 'configured') return;
    const rtUrl = configState.config.url.replace(/^http/, 'ws') + '/realtime/v1';

    const rt = new RealtimeClient(rtUrl, {
      params: { apikey: configState.config.anonKey },
    });
    rtClientRef.current = rt;

    rt.setAuth(accessToken);
    rt.connect();

    const channel = rt.channel(`sync:private:${userId}`, {
      config: {
        private: true,
        broadcast: { self: false },
      },
    });
    channelRef.current = channel;

    channel.on('broadcast', { event: 'sync_nudge' }, (payload) => {
      if (payload?.sender_id === deviceId) {
        return; // suppress echo
      }
      triggerDebouncedSync();
    });

    channel.subscribe((subStatus) => {
      if (subStatus === 'SUBSCRIBED') {
        recordLog('info', `Realtime: Subscribed to private channel sync:private:${userId}`);
      } else if (subStatus === 'CHANNEL_ERROR') {
        recordLog('warn', `Realtime: Channel error joining sync:private:${userId}`);
      }
    });
    // Keyed on `accessToken` (a primitive), not the `session` object itself:
    // `ensureAnonymousSession` calls `setSession(active)` unconditionally on
    // every sync pass (auth-provider.tsx), handing back a structurally-equal
    // but reference-new session even when the token didn't change. Depending
    // on `session` directly would reintroduce the exact STASH-K churn this
    // file just removed for `syncNow` — every sync-triggered session refresh
    // would still tear down and rebuild the socket from scratch.
  }, [accessToken, status, userId, deviceId, triggerDebouncedSync, disconnectSocket]);

  // Lifecycle listeners. Deliberately keyed on `connectSocket`/`disconnectSocket`
  // only, not `syncNow` (read via `syncNowRef` above instead) — those two are
  // now stable across a `syncNow` identity change, so this effect no longer
  // tears down and rebuilds the socket (disconnect+connect+new channel) on
  // every sync-driven re-render. Sentry STASH-K traced JS-thread stalls to
  // slow "react-cycle" segments during active syncing; that churn — a fresh
  // RealtimeClient/channel/subscribe on nearly every processed queue entry —
  // was a real, avoidable cost hiding in what looked like ordinary React work.
  useEffect(() => {
    connectSocket();
    const handleStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        connectSocket();
        // Catch up on any changes missed while backgrounded/offline
        void syncNowRef.current().catch(() => {});
      } else {
        disconnectSocket();
        if (debounceTimeoutRef.current) {
          clearTimeout(debounceTimeoutRef.current);
          debounceTimeoutRef.current = null;
        }
      }
    };

    const subscription = AppState.addEventListener('change', handleStateChange);
    return () => {
      subscription.remove();
      disconnectSocket();
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [connectSocket, disconnectSocket]);

  const broadcastSyncNudge = useCallback(() => {
    if (!channelRef.current || !deviceId) {
      return;
    }
    // Coalesce: if a send is already scheduled, this call's intent is
    // already covered — see NUDGE_SEND_DEBOUNCE_MS above.
    if (nudgeSendTimeoutRef.current) {
      return;
    }
    nudgeSendTimeoutRef.current = setTimeout(() => {
      nudgeSendTimeoutRef.current = null;
      channelRef.current?.send({
        type: 'broadcast',
        event: 'sync_nudge',
        payload: {
          sender_id: deviceId,
          sent_at: new Date().toISOString(),
        },
      });
    }, NUDGE_SEND_DEBOUNCE_MS);
  }, [deviceId]);

  return { broadcastSyncNudge };
}
