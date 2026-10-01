import { useEffect, useState } from 'react';
import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network';

/** Unknown/unavailable connectivity never becomes an invented offline diagnosis. */
export function useNetworkOffline(): boolean {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let active = true;
    let observedEvent = false;
    let subscription: ReturnType<typeof addNetworkStateListener> | undefined;
    const accept = (state: NetworkState | undefined) => {
      const definite = typeof state?.isConnected === 'boolean' || typeof state?.isInternetReachable === 'boolean';
      if (active && definite) setOffline(state?.isConnected === false || state?.isInternetReachable === false);
      return definite;
    };
    try {
      subscription = addNetworkStateListener((state) => { observedEvent = accept(state) || observedEvent; });
      void Promise.resolve(getNetworkStateAsync()).then((state) => {
        if (!observedEvent) accept(state);
      }).catch(() => {});
    } catch { /* An unavailable observer leaves connectivity unknown. */ }
    return () => { active = false; subscription?.remove?.(); };
  }, []);
  return offline;
}
