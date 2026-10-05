import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network';

/** Unknown/unavailable connectivity never becomes an invented offline diagnosis. */
export function useNetworkOffline(): boolean {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let active = true;
    let observationVersion = 0;
    let requestVersion = 0;
    let subscription: ReturnType<typeof addNetworkStateListener> | undefined;
    const accept = (state: NetworkState | undefined) => {
      // Android's observer also returns UNKNOWN with false flags when reading
      // connectivity fails. That is not evidence of a disconnected device;
      // web's UNKNOWN with true flags still provides a useful online signal.
      if (state?.type === 'UNKNOWN' && state.isConnected !== true && state.isInternetReachable !== true) return false;
      const definite = typeof state?.isConnected === 'boolean' || typeof state?.isInternetReachable === 'boolean';
      if (active && definite) setOffline(state?.isConnected === false || state?.isInternetReachable === false);
      return definite;
    };
    const refresh = () => {
      const request = ++requestVersion;
      const observation = observationVersion;
      try {
        void Promise.resolve(getNetworkStateAsync()).then((state) => {
          // Only the newest query in this foreground session can publish, and
          // never over a definite listener event received since it started.
          if (active && request === requestVersion && observation === observationVersion) accept(state);
        }).catch(() => {});
      } catch { /* Keep the last known observation when querying is unavailable. */ }
    };
    try {
      subscription = addNetworkStateListener((state) => { if (accept(state)) observationVersion += 1; });
    } catch { /* An unavailable observer leaves connectivity unknown. */ }
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
      else requestVersion += 1;
    });
    refresh();
    return () => { active = false; subscription?.remove?.(); appStateSubscription.remove(); };
  }, []);
  return offline;
}
