#!/usr/bin/env node
// Real-render screenshot of a Stash screen via the Expo *web* export + headless
// Chromium. No emulator: this renders the actual app code in ~1 min, between
// `ui-preview` (instant, approximate SVG) and the `android-screenshots` CI
// emulator (native, ~15 min).
//
// Two modes:
//   • default — render whatever state the app boots into (a fresh export is the
//     empty first-run state); live network, so a Supabase pull / remote images
//     can load.
//   • injected — pass any data flag (--count/--seed/--tags/--collections/
//     --archived/--data) to prime localStorage BEFORE the app boots so the
//     screen renders with bookmarks/tags/collections/AI-suggestions of your
//     choosing. Injected mode also aborts every non-localhost request, so a
//     Supabase pull can't replace the injected tag data and remote assets can't
//     stall the render — fully offline and deterministic (same --seed → same
//     pixels).
//
// Usage:
//   node render.mjs [--route /|inbox|settings|review|add|trash|browse-tags|report]
//                   [--theme light|dark] [--out PATH] [--width 390] [--height 844]
//                   [--scale 2] [--full]
//                   [--count N] [--seed S] [--tags N] [--collections N]
//                   [--archived N] [--data fixture.json]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { extname, join, normalize, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { generate } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = normalize(join(HERE, '..', '..', '..'));
const DIST = join(REPO, 'apps', 'mobile', 'dist');

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const num = (k, d) => {
  const v = arg(k, undefined);
  return v === undefined ? d : Number(v);
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
const width = num('width', 390);
const height = num('height', 844);
const scale = num('scale', 2);
const fullPage = has('full');
const dataFile = arg('data', undefined);

// Injected mode is on when any data flag is present. Presence, not value, so the
// generation defaults don't force it — a bare `render.mjs` renders the real
// boot state exactly as before.
const DATA_FLAGS = ['data', 'count', 'seed', 'tags', 'collections', 'archived'];
const injecting = DATA_FLAGS.some((k) => has(k));

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

// ---- build the injectable dataset (injected mode only) ---------------------
async function buildDataset() {
  if (dataFile) {
    const fp = isAbsolute(dataFile) ? dataFile : join(process.cwd(), dataFile);
    const parsed = JSON.parse(await readFile(fp, 'utf8'));
    // Accept a full {bookmarks, tagData, enrichments} bundle or a bare
    // bookmarks array. Missing pieces default to empty (no generation).
    if (Array.isArray(parsed)) {
      return { bookmarks: parsed, tagData: { tags: [], bookmarkTags: [], collections: [] }, enrichments: [] };
    }
    return {
      bookmarks: parsed.bookmarks ?? [],
      tagData: parsed.tagData ?? {
        tags: parsed.tags ?? [],
        bookmarkTags: parsed.bookmarkTags ?? [],
        collections: parsed.collections ?? [],
      },
      enrichments: parsed.enrichments ?? [],
    };
  }
  return generate({
    count: num('count', 8),
    seed: num('seed', 1),
    tags: num('tags', 6),
    collections: num('collections', 3),
    archived: num('archived', 0),
  });
}

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

  if (injecting) {
    const data = await buildDataset();
    // localStorage payload mirrors storage/repository.ts's `write` (JSON.stringify
    // per key). `stash.seeded` must be the JSON string "1" so init() skips the
    // empty re-seed and keeps our injected rows.
    const payload = {
      'stash.bookmarks': JSON.stringify(data.bookmarks),
      'stash.tagData': JSON.stringify(data.tagData),
      'stash.enrichments': JSON.stringify(data.enrichments),
      'stash.queue': JSON.stringify([]),
      'stash.seeded': JSON.stringify('1'),
    };
    // Prime localStorage before any app script runs.
    await ctx.addInitScript((kv) => {
      try {
        for (const k in kv) localStorage.setItem(k, kv[k]);
      } catch {
        /* SSR / no storage — ignore */
      }
    }, payload);
    // Offline determinism: only localhost (our static server) is allowed. Blocks
    // the Supabase pull that would replace tagData wholesale, and any remote
    // image/font that would stall `networkidle`.
    await ctx.route('**/*', (r) => {
      const host = (() => {
        try {
          return new URL(r.request().url()).hostname;
        } catch {
          return '';
        }
      })();
      if (host === 'localhost' || host === '127.0.0.1') return r.continue();
      return r.abort();
    });
  }

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 200)));

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  // The tree seeds/hydrates on mount; wait for real content instead of a fixed
  // sleep. Any of these strings means the tree rendered.
  await page
    .waitForFunction(() => /Stash|Saved|Settings|Review|Add|Inbox/i.test(document.body.innerText), null, {
      timeout: 12000,
    })
    .catch(() => {});
  await page.waitForTimeout(injecting ? 700 : 600);

  // Dark theme: recolor any element still painted with the baked light
  // container background (static-export hydration leaves it light).
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
