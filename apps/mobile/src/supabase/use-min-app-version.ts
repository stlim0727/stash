import { useEffect, useState } from 'react';

import { APP_CONFIG_KEYS, parseRemoteAppConfig, type RemoteAppConfig } from '@/domain/app-config';
import { getSupabaseConfigState } from '@/supabase/config';

/** Fetches public release-gate config. Missing config or network failure never blocks capture. */
export function useAppConfig(): RemoteAppConfig {
  const [appConfig, setAppConfig] = useState<RemoteAppConfig>(() => parseRemoteAppConfig([]));

  useEffect(() => {
    const configState = getSupabaseConfigState();
    if (configState.status !== 'configured') {
      return;
    }
    const { url, anonKey } = configState.config;
    const keys = APP_CONFIG_KEYS.join(',');
    fetch(`${url}/rest/v1/app_config?key=in.(${keys})&select=key,value`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
    })
      .then((res) => res.json())
      .then((rows: { key: string; value: string | null }[]) => setAppConfig(parseRemoteAppConfig(rows)))
      .catch(() => {
        // Network unavailable: don't block capture or offline use.
      });
  }, []);

  return appConfig;
}

/** Backward-compatible helper for callers that only need the minimum version. */
export function useMinAppVersion(): string | null {
  return useAppConfig().minAppVersion;
}
