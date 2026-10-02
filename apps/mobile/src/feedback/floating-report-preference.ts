import { useEffect, useState } from 'react';
import { getPreference, setPreference } from '@/storage/preferences';
import { useBookmarks } from '@/store/bookmarks';

export const FLOATING_REPORT_PREF_KEY = 'pref.feedback.floatingReportButton';

const listeners = new Set<(enabled: boolean) => void>();

export async function setFloatingReportPreference(enabled: boolean): Promise<void> {
  await setPreference(FLOATING_REPORT_PREF_KEY, enabled ? 'true' : 'false');
  for (const listener of listeners) {
    listener(enabled);
  }
}

export function useFloatingReportPreference(): [boolean, (value: boolean) => void] {
  const { isLoading } = useBookmarks();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (isLoading) return;
    let active = true;
    getPreference(FLOATING_REPORT_PREF_KEY)
      .then((raw) => {
        if (active && raw === 'true') {
          setEnabled(true);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isLoading]);

  useEffect(() => {
    const listener = (val: boolean) => setEnabled(val);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const updatePreference = (val: boolean) => {
    setEnabled(val);
    void setFloatingReportPreference(val).catch(() => {});
  };

  return [enabled, updatePreference];
}
