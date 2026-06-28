#!/usr/bin/env node
// Real-render screenshot of a Stash screen via the Expo *web* export + headless
// Chromium. No emulator: this renders the actual app code (with its first-run
// mock seed) in ~1 min, between `ui-preview` (instant, approximate SVG) and the
// `android-screenshots` CI emulator (native, ~15 min).
//
// Usage:
//   node render.mjs [--route /|inbox|settings|review|add|trash|browse-tags|report]
//                   [--theme light|dark] [--out PATH] [--width 390] [--height 844]
//                   [--scale 2] [--full]
//
// Speed notes: reuses an existing apps/mobile/dist (pass --rebuild upstream to
// force a fresh export), prefers the chromium headless_shell binary, and waits
// on seeded content rather than fixed sleeps.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = normalize(join(HERE, '..', '..', '..'));
const DIST = join(REPO, 'apps', 'mobile', 'dist');

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const has = (k) => argv.includes(`--${k}`);

const ROUTES = {
  '/': '/', inbox: '/', home: '/',
  settings: '/settings', review: '/review', add: '/add',
  trash: '/trash', report: '/report', 'browse-tags': '/browse/tags',
};
const routeArg = arg('route', '/');
const route = ROUTES[routeArg] ?? routeArg;
const theme = arg('theme', 'light') === 'dark' ? 'dark' : 'light';
const out = arg('out', `/tmp/stash-${routeArg.replace(/\W+/g, '-')}-${theme}.png`);
const width = Number(arg('width', 390));
const height = Number(arg('height', 844));
const scale = Number(arg('scale', 2));
const fullPage = has('full');

// Light-palette colors that the Expo static export prerenders and that survive
// hydration on some components (container, the odd surface chip), leaving a
// light leak behind dark cards. In dark mode we remap each to its dark-palette
// counterpart. Values from apps/mobile/src/theme.ts (light → dark):
//   background #f7f9fc → #0b1220,  surface/card #ffffff → #151c2c.
const DARK_RECOLOR = [
  { from: 'rgb(247, 249, 252)', to: '#0b1220' },
  { from: 'rgb(255, 255, 255)', to: '#151c2c' },
];
const DARK_BG = '#0b1220';

// ---- resolve the pre-installed Chromium ------------------------------------
function resolveChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  let dirs = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return undefined; // let playwright try its own bundled browser
  }
  // Prefer headless_shell (faster cold start) over full chrome.
  const shell = dirs.find((d) => d.startsWith('chromium_headless_shell'));
  if (shell) return join(root, shell, 'chrome-linux', 'headless_shell');
  const full = dirs.find((d) => d.startsWith('chromium-'));
  if (full) return join(root, full, 'chrome-linux', 'chrome');
  return undefined;
}

// ---- tiny static server for dist/ ------------------------------------------
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json',
};
function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/' || p === '') p = '/index.html';
      let fp = normalize(join(DIST, p));
      if (!fp.startsWith(DIST)) return void res.writeHead(403).end();
      try {
        const s = await stat(fp);
        if (s.isDirectory()) fp = join(fp, 'index.html');
      } catch {
        // Expo exports each route as <route>.html; fall back to it, then index.
        if (!extname(fp)) {
          try {
            await stat(`${fp}.html`);
            fp = `${fp}.html`;
          } catch {
            fp = join(DIST, 'index.html');
          }
        }
      }
      const body = await readFile(fp);
      res.writeHead(200, { 'content-type': TYPES[extname(fp)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) {
      res.writeHead(404).end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

// ---------------------------------------------------------------------------
async function main() {
  try {
    await stat(join(DIST, 'index.html'));
  } catch {
    console.error(
      `No web export found at ${DIST}.\n` +
        `Build it first:\n  cd apps/mobile && CI=1 pnpm exec expo export --platform web`,
    );
    process.exit(2);
  }

  const server = await startServer();
  const port = server.address().port;
  const url = `http://localhost:${port}${route.startsWith('/') ? route : `/${route}`}`;

  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'],
  });
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    colorScheme: theme,
    isMobile: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 200)));

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  // The store seeds mock data on mount; wait for real content instead of a
  // fixed sleep. Any of these strings means the tree rendered.
  await page
    .waitForFunction(() => /Stash|Saved|Settings|Review|Add/i.test(document.body.innerText), null, {
      timeout: 12000,
    })
    .catch(() => {});
  await page.waitForTimeout(600);

  // Fixup 1 — RN-web Image quirk: the brand wordmark <img> ignores its
  // aspectRatio+height and lays out at full intrinsic width (~1294px), shoving
  // the inline saved-count off-screen and hiding behind the header layer.
  // Pin the sizer + wrapper, then overlay the same asset so it actually paints.
  await page.evaluate(() => {
    const img = [...document.querySelectorAll('img')].find((i) => /wordmark/.test(i.src));
    if (!img || !img.naturalWidth) return;
    const w = 30 * (img.naturalWidth / img.naturalHeight);
    img.style.setProperty('height', '30px', 'important');
    img.style.setProperty('width', `${w}px`, 'important');
    img.style.setProperty('object-fit', 'contain', 'important');
    if (img.parentElement) {
      img.parentElement.style.setProperty('width', `${w}px`, 'important');
      img.parentElement.style.setProperty('flex', '0 0 auto', 'important');
      img.parentElement.style.setProperty('overflow', 'visible', 'important');
    }
    const r = img.getBoundingClientRect();
    const o = document.createElement('img');
    o.src = img.src;
    o.style.cssText = `position:fixed;left:${r.x}px;top:${r.y}px;height:30px;width:auto;z-index:99999;`;
    document.body.appendChild(o);
  });

  // Fixup 2 — dark theme: recolor any element still painted with the baked
  // light container background (static-export hydration leaves it light).
  if (theme === 'dark') {
    await page.evaluate(
      ({ map, darkBg }) => {
        const lut = new Map(map.map((m) => [m.from, m.to]));
        for (const el of document.querySelectorAll('*')) {
          // Leave images alone (favicon frames etc. are legitimately light).
          if (el.tagName === 'IMG') continue;
          const to = lut.get(getComputedStyle(el).backgroundColor);
          if (to) el.style.setProperty('background-color', to, 'important');
        }
        document.documentElement.style.background = darkBg;
        document.body.style.background = darkBg;
      },
      { map: DARK_RECOLOR, darkBg: DARK_BG },
    );
  }

  await page.waitForTimeout(300);
  await page.screenshot({ path: out, fullPage });
  console.log(out);

  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
