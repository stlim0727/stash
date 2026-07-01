/**
 * Native no-op. The "Save to Stash" bookmarklet is a desktop-web affordance;
 * the real implementation lives in `BookmarkletButton.web.tsx` and is picked by
 * Metro's platform extensions on web. Kept as a matching export so the shared
 * import resolves on iOS/Android (where it renders nothing).
 */
export function BookmarkletButton(_props: {
  label: string;
  copiedLabel: string;
  accent: string;
}) {
  return null;
}
