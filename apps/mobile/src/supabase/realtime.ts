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

export function useRealtimeSync({ session, status, userId, syncNow }: RealtimeSyncProps) {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const rtClientRef = useRef<RealtimeClient | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
      void syncNow().catch((err) => recordLog('warn', `Realtime sync failed: ${String(err)}`));
    }, 3000);
  }, [syncNow]);

  const disconnectSocket = useCallback(() => {
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
    if (status !== 'authenticated' || !session || !userId || AppState.currentState !== 'active') {
      disconnectSocket();
      return;
    }

    if (rtClientRef.current) {
      rtClientRef.current.setAuth(session.access_token);
      return;
    }

    const configState = getSupabaseConfigState();
    if (configState.status !== 'configured') return;
    const rtUrl = configState.config.url.replace(/^http/, 'ws') + '/realtime/v1';

    const rt = new RealtimeClient(rtUrl, {
      params: { apikey: configState.config.anonKey },
    });
    rtClientRef.current = rt;

    rt.setAuth(session.access_token);
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
  }, [session, status, userId, deviceId, triggerDebouncedSync, disconnectSocket]);

  // Lifecycle listeners
  useEffect(() => {
    connectSocket();
    const handleStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        connectSocket();
        // Catch up on any changes missed while backgrounded/offline
        void syncNow().catch(() => {});
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
  }, [connectSocket, disconnectSocket, syncNow]);

  const broadcastSyncNudge = useCallback(() => {
    if (channelRef.current && deviceId) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'sync_nudge',
        payload: {
          sender_id: deviceId,
          sent_at: new Date().toISOString(),
        },
      });
    }
  }, [deviceId]);

  return { broadcastSyncNudge };
}
