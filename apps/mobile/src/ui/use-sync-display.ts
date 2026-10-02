import { useEffect, useState } from 'react';
import { advanceSyncDisplay, INITIAL_SYNC_DISPLAY, nextSyncDisplayAt, type LibrarySyncFlow } from '@/domain/library-sync-status';

export function useSyncDisplay(flow: LibrarySyncFlow, scope: string) {
  const [state, setState] = useState({ scope, display: INITIAL_SYNC_DISPLAY });
  const display = advanceSyncDisplay(state.scope === scope ? state.display : INITIAL_SYNC_DISPLAY, flow, Date.now());
  useEffect(() => {
    const current = advanceSyncDisplay(state.scope === scope ? state.display : INITIAL_SYNC_DISPLAY, flow, Date.now());
    if (state.scope !== scope || current.phase !== state.display.phase ||
        current.busySince !== state.display.busySince || current.completeUntil !== state.display.completeUntil) {
      setState({ scope, display: current });
    }
    const deadline = nextSyncDisplayAt(current, flow);
    if (deadline === null) return;
    const timer = setTimeout(() => setState({ scope, display: advanceSyncDisplay(current, flow, Date.now()) }), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [state, flow.phase, flow.remaining, scope]);
  return display.phase;
}
