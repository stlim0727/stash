import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useT } from '@/i18n';
import { takePendingShareConfirm } from '@/share/pending-confirm';
import { useCaptureToast } from '@/ui/capture-toast';

/**
 * Surfaces the "did that actually save?" confirmation for a toast-mode share
 * the *next* time Stash is opened.
 *
 * A toast-mode share on Android saves durably and then dismisses the app, so
 * its only confirmation — a system toast — is gone by the time you come back.
 * Rather than drag you to the Inbox on reopen (you might be mid-task on the
 * screen you left), we leave you exactly where you were and float a modeless
 * toast confirming the save, with a "View" shortcut that jumps to the Inbox
 * only if you choose to. The record itself is written by the share handler
 * before it exits; here we just drain it on the way back in.
 *
 * Two foreground paths are covered, matching how the OS brings the app back:
 *  - a warm resume keeps the tree mounted and only fires an AppState
 *    transition, and
 *  - a cold start mounts fresh with no transition.
 * `takePendingShareConfirm` reads-and-clears atomically, so even if both fire
 * the confirmation shows once. The share-handling session never drains its own
 * record: it writes it only moments before `exitApp()`, long after this
 * component's mount check has already run against an empty store.
 *
 * Renders nothing; the toast lives in the shared `CaptureToastProvider`.
 */
export function ShareConfirmHandler() {
  const router = useRouter();
  const { show } = useCaptureToast();
  const t = useT();
  // Latches the last AppState so we only react to genuine background→active
  // transitions, not the inactive↔active flicker iOS emits for control centre,
  // notification shade, biometric prompts, etc.
  const appState = useRef(AppState.currentState);

  const flush = useCallback(async () => {
    const pending = await takePendingShareConfirm();
    if (!pending) {
      return;
    }
    show(t('inbox.savedCount', { count: pending.savedCount }), {
      label: t('common.view'),
      onPress: () => router.replace('/'),
    });
  }, [show, t, router]);

  // Cold start: the app mounts already foregrounded, with no AppState change to
  // hook, so check once on mount.
  useEffect(() => {
    void flush();
  }, [flush]);

  // Warm resume: the tree stays mounted, so listen for the return to the
  // foreground from a true background.
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      const wasBackgrounded = appState.current.match(/inactive|background/);
      appState.current = next;
      if (wasBackgrounded && next === 'active') {
        void flush();
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [flush]);

  return null;
}
