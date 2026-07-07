/**
 * Native OS UI font stack: San Francisco on Apple, Segoe UI on Windows, Roboto
 * on Android/ChromeOS. Same idea as the Android APK, which renders in the
 * system font (Roboto).
 */
import { palettes } from '@/theme';

const SYSTEM_FONT_STACK =
  'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",' +
  'Arial,"Noto Sans",sans-serif,"Apple Color Emoji","Segoe UI Emoji",' +
  '"Segoe UI Symbol","Noto Color Emoji"';

/**
 * Web base font: use the native system UI stack directly. This keeps Windows
 * desktop text crisp and avoids synthesized/heavy webfont bold weights in the
 * dense bookmark grid.
 */
const BASE_FONT_CSS =
  `html{font-family:${SYSTEM_FONT_STACK};` +
  '-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;' +
  'text-rendering:optimizeLegibility;}';

/**
 * Ionicons icon font, self-hosted at a dot-free static path.
 *
 * expo-router's static web export emits the vendored icon font under
 * `/assets/__node_modules/.pnpm/…/Ionicons.<hash>.ttf`, and `@expo/vector-icons`
 * loads it from that URL at runtime. Static hosts refuse to serve paths inside
 * pnpm's dot-prefixed `.pnpm` directory (Netlify returns the SPA `index.html`
 * fallback; Cloudflare 307s), so the request never yields a font and every
 * Ionicon renders as a `□` tofu box. Registering the family ourselves from a
 * committed `/fonts/ionicons.ttf` (same self-host trick as Inter above) means
 * the glyphs resolve from a servable URL regardless of the broken `.pnpm`
 * fetch. `font-display:block` keeps icons blank-then-drawn rather than flashing
 * tofu while the (same-origin, cached) font loads. Ionicons is the only family
 * we use, so one face covers the whole UI.
 */
const ICON_FONT_CSS =
  "@font-face{font-family:'Ionicons';font-style:normal;font-weight:400;" +
  "font-display:block;src:url('/fonts/ionicons.ttf') format('truetype');}";

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
  // Apply the base font. Text with no explicit `fontFamily` inherits from
  // `html`, so this styles the whole UI while leaving the few intentional
  // overrides (e.g. the monospace report view) untouched.
  if (!document.head.querySelector('style#stash-base-font')) {
    const style = document.createElement('style');
    style.id = 'stash-base-font';
    style.textContent = BASE_FONT_CSS + ICON_FONT_CSS;
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
