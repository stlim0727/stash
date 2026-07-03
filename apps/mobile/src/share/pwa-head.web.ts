/**
 * Inject the PWA <head> tags at runtime (web only).
 *
 * With `web.output: "single"` (SPA) the expo-router `+html.tsx` template isn't
 * used, so the manifest link, theme color, and apple-touch-icon must be added to
 * `document.head` on the client instead. Each is added only if absent, so it's
 * idempotent and never duplicates a tag. The manifest declares the Web Share
 * Target (`share_target → /add`), so an installed PWA shows up in the OS share
 * sheet on Android.
 */
export function installPwaHead() {
  if (typeof document === 'undefined') {
    return;
  }
  const ensure = (selector: string, tag: string, attrs: Record<string, string>) => {
    if (document.head.querySelector(selector)) {
      return;
    }
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }
    document.head.appendChild(el);
  };
  ensure('link[rel="manifest"]', 'link', { rel: 'manifest', href: '/manifest.webmanifest' });
  ensure('meta[name="theme-color"]', 'meta', { name: 'theme-color', content: '#208aef' });
  ensure('link[rel="apple-touch-icon"]', 'link', {
    rel: 'apple-touch-icon',
    href: '/icon-1024.png',
  });
}
