import { createElement, useEffect, useRef, useState } from 'react';

import { buildBookmarklet } from '@/domain/web-capture';

/**
 * A draggable "Save to Stash" bookmarklet — web only. Rendered as a real DOM
 * `<a>` whose href is the bookmarklet, so dragging it to the bookmarks bar
 * installs it. React refuses to render a `javascript:` href, so it is set via a
 * ref after mount. Clicking (rather than dragging) copies the code as a
 * fallback — a plain click on the Settings page would otherwise just try to
 * stash the Settings page. On native this module resolves to
 * `BookmarkletButton.tsx`, which renders nothing.
 */
export function BookmarkletButton({
  label,
  copiedLabel,
  accent,
}: {
  label: string;
  copiedLabel: string;
  accent: string;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // window only exists client-side; Settings is also statically rendered.
    ref.current?.setAttribute('href', buildBookmarklet(window.location.origin));
  }, []);

  return createElement(
    'a',
    {
      ref,
      draggable: true,
      onClick: (event: { preventDefault: () => void }) => {
        event.preventDefault();
        try {
          void navigator.clipboard?.writeText(buildBookmarklet(window.location.origin));
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard unavailable (older browser / insecure context) — the drag
          // path still works, so fail quietly.
        }
      },
      style: {
        display: 'inline-block',
        padding: '10px 18px',
        borderRadius: 999,
        backgroundColor: accent,
        color: '#ffffff',
        fontWeight: 600,
        fontSize: 15,
        textDecoration: 'none',
        cursor: 'grab',
        userSelect: 'none',
      },
    },
    copied ? copiedLabel : label,
  );
}
