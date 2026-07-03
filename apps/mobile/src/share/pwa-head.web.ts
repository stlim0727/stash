/**
 * Native OS UI font stack — the same idea as the Android APK, which renders in
 * the system font (Roboto). This resolves to San Francisco on Apple, Segoe UI on
 * Windows, and Roboto on Android/ChromeOS, so web text looks native everywhere
 * with zero loading overhead: no webfont request, no downloaded payload, no FOUT.
 */
import { palettes } from '@/theme';

const SYSTEM_FONT_STACK =
  'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",' +
  'Arial,"Noto Sans",sans-serif,"Apple Color Emoji","Segoe UI Emoji",' +
  '"Segoe UI Symbol","Noto Color Emoji"';

/**
 * Inject the PWA <head> tags at runtime (web only).
 *
 * With `web.output: "single"` (SPA) the expo-router `+html.tsx` template isn't
 * used, so the manifest link, theme color, apple-touch-icon, and base font must
 * be added to `document.head` on the client instead. Each is added only if
 * absent, so it's idempotent and never duplicates a tag. The manifest declares
 * the Web Share Target (`share_target → /add`), so an installed PWA shows up in
 * the OS share sheet on Android.
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
  // Apply the native system font stack. Text with no explicit `fontFamily`
  // inherits from `html`, so this styles the whole UI while leaving the few
  // intentional overrides (e.g. the monospace report view) untouched.
  if (!document.head.querySelector('style#stash-base-font')) {
    const style = document.createElement('style');
    style.id = 'stash-base-font';
    style.textContent =
      `html{font-family:${SYSTEM_FONT_STACK};` +
      '-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;' +
      'text-rendering:optimizeLegibility;}';
    document.head.appendChild(style);
  }
  // The SPA shell (index.html) leaves html/body transparent — only the app's
  // ScrollView paints the theme background, and it's sized to the `height:100%`
  // root. Any area outside that box falls through to the browser's default
  // white: the strip a mobile browser exposes when its URL bar collapses and
  // grows the visual viewport past 100%, or an overscroll bounce. Paint the
  // page itself the theme background so that gap matches the app instead of
  // flashing white. Theme-aware via prefers-color-scheme, which is exactly what
  // useColorScheme() keys the in-app theme off of.
  if (!document.head.querySelector('style#stash-page-bg')) {
    const style = document.createElement('style');
    style.id = 'stash-page-bg';
    style.textContent =
      `html,body{background-color:${palettes.light.background};}` +
      `@media (prefers-color-scheme:dark){html,body{background-color:${palettes.dark.background};}}`;
    document.head.appendChild(style);
  }
  ensure('link[rel="manifest"]', 'link', { rel: 'manifest', href: '/manifest.webmanifest' });
  ensure('meta[name="theme-color"]', 'meta', { name: 'theme-color', content: '#208aef' });
  ensure('link[rel="apple-touch-icon"]', 'link', {
    rel: 'apple-touch-icon',
    href: '/icon-1024.png',
  });
}
