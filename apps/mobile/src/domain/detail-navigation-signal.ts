/**
 * Navigation feedback coordination between BookmarkDetailScreen and InboxScreen.
 *
 * When an inbox bookmark card is tapped, a 150ms timer is armed to show a busy spinner
 * only if navigation/mounting experiences a real delay (>150ms). When BookmarkDetailScreen
 * successfully mounts, it emits a signal so InboxScreen can cancel any pending timer
 * immediately, preventing unnecessary background re-renders of the Inbox list during
 * or after navigation.
 */

type DetailOpenListener = (bookmarkId: string) => void;

const listeners = new Set<DetailOpenListener>();

export function registerDetailOpenListener(listener: DetailOpenListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyDetailMounted(bookmarkId: string): void {
  for (const listener of listeners) {
    listener(bookmarkId);
  }
}
