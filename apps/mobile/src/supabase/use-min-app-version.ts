import { useEffect, useState } from 'react';

import { getSupabaseConfigState } from '@/supabase/config';

/** Fetches the min_app_version from the app_config table. Returns null while loading or when Supabase is not configured. */
export function useMinAppVersion(): string | null {
  const [minVersion, setMinVersion] = useState<string | null>(null);

  useEffect(() => {
    const configState = getSupabaseConfigState();
    if (configState.status !== 'configured') {
      return;
    }
    const { url, anonKey } = configState.config;
    fetch(`${url}/rest/v1/app_config?key=eq.min_app_version&select=value`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
    })
      .then((res) => res.json())
      .then((rows: { value: string }[]) => {
        if (rows[0]?.value) {
          setMinVersion(rows[0].value);
        }
      })
      .catch(() => {
        // Network unavailable — don't block the user.
      });
  }, []);

  return minVersion;
}
