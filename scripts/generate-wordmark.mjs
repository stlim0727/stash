/**
 * Regenerate the Inbox hero wordmark images.
 *
 * The hero title (apps/mobile/src/app/index.tsx) is a pre-rendered PNG rather
 * than a bundled display font — a few KB of image instead of multi-MB font
 * files. This script bakes the glyphs into four assets:
 *
 *   assets/images/wordmark-en-light.png   "Stash"            (light theme)
 *   assets/images/wordmark-en-dark.png    "Stash"            (dark theme)
 *   assets/images/wordmark-ko-light.png   "Stash │ 스태시"   (light theme)
 *   assets/images/wordmark-ko-dark.png    "Stash │ 스태시"   (dark theme)
 *
 * To change the hero font, edit FONTS below (family + a direct .ttf/.otf URL),
 * run the script, and paste the printed aspect ratios into the WORDMARK map in
 * index.tsx. Colors mirror apps/mobile/src/theme.ts (text / textSecondary).
 *
 * Usage (needs `sharp`, which is not a project dependency):
 *   pnpm add -Dw sharp            # one-time, or use an existing global install
 *   node scripts/generate-wordmark.mjs
 *
 * Fonts are downloaded once into scripts/.wordmark-cache/ (gitignored) and
 * rendered through an isolated fontconfig so nothing touches the system fonts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'apps/mobile/assets/images');
const CACHE = join(ROOT, 'scripts/.wordmark-cache');

// ── Edit these to re-skin the hero ──────────────────────────────────────────
const TEXT = { latin: 'Stash', local: '스태시' };
const FONTS = {
  // The Latin wordmark ("Stash").
  latin: {
    family: 'Gothic A1',
    weight: 800,
    url: 'https://github.com/google/fonts/raw/main/ofl/gothica1/GothicA1-ExtraBold.ttf',
  },
  // The locale-native wordmark ("스태시").
  local: {
    family: 'Gowun Dodum',
    weight: 400,
    url: 'https://github.com/google/fonts/raw/main/ofl/gowundodum/GowunDodum-Regular.ttf',
  },
};
// Colors mirror theme.ts (light/dark). `div` is the thin divider between words.
const THEMES = {
  light: { ink: '#101828', sub: '#667085', div: '#cdd5e0' },
  dark: { ink: '#f8fafc', sub: '#a7b0c0', div: '#2a3548' },
};
const FS = 120; // base "Stash" size in SVG units; the asset is downscaled in-app
const KO_RATIO = 0.59; // 스태시 size relative to "Stash"
// ────────────────────────────────────────────────────────────────────────────

function download(url, dest) {
  if (existsSync(dest)) {
    return;
  }
  console.log(`↓ ${url}`);
  execFileSync('curl', ['-sL', '--fail', '--max-time', '60', '-o', dest, url]);
}

function svgEN(c) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="220">
    <text x="20" y="160" font-family="${FONTS.latin.family}" font-weight="${FONTS.latin.weight}" font-size="${FS}" fill="${c.ink}" letter-spacing="-3">${TEXT.latin}</text>
  </svg>`;
}

function svgKO(c) {
  const ko = Math.round(FS * KO_RATIO);
  // Generous x positions; sharp.trim() crops the transparent margins after.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="220">
    <text x="20" y="160" font-family="${FONTS.latin.family}" font-weight="${FONTS.latin.weight}" font-size="${FS}" fill="${c.ink}" letter-spacing="-3">${TEXT.latin}</text>
    <rect x="430" y="86" width="5" height="78" rx="2.5" fill="${c.div}"/>
    <text x="470" y="156" font-family="${FONTS.local.family}" font-weight="${FONTS.local.weight}" font-size="${ko}" fill="${c.sub}" letter-spacing="-1">${TEXT.local}</text>
  </svg>`;
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  // Fetch the fonts and point an isolated fontconfig at them, so rendering is
  // deterministic and doesn't depend on (or modify) the system font set.
  download(FONTS.latin.url, join(CACHE, 'latin.ttf'));
  download(FONTS.local.url, join(CACHE, 'local.ttf'));
  const conf = join(CACHE, 'fonts.conf');
  writeFileSync(
    conf,
    `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${CACHE}</dir>\n  <cachedir>${join(CACHE, 'fccache')}</cachedir>\n</fontconfig>\n`,
  );
  process.env.FONTCONFIG_FILE = conf;

  // Import sharp only after FONTCONFIG_FILE is set (fontconfig reads it at init).
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.error('\n✗ `sharp` is required. Install it first:\n    pnpm add -Dw sharp\n');
    process.exit(1);
  }

  const jobs = [];
  for (const [theme, c] of Object.entries(THEMES)) {
    jobs.push(['en', theme, svgEN(c)]);
    jobs.push(['ko', theme, svgKO(c)]);
  }

  const ratios = {};
  for (const [loc, theme, svg] of jobs) {
    const file = join(OUT, `wordmark-${loc}-${theme}.png`);
    const info = await sharp(Buffer.from(svg), { density: 300 })
      .png()
      .trim({ threshold: 0 })
      .toFile(file);
    ratios[loc === 'en' ? 'en' : 'local'] = +(info.width / info.height).toFixed(3);
    console.log(
      `✓ wordmark-${loc}-${theme}.png  ${info.width}x${info.height}  ${(info.size / 1024).toFixed(1)}KB`,
    );
  }

  console.log(
    `\nPaste these ratios into the WORDMARK map in apps/mobile/src/app/index.tsx:\n` +
      `    en.ratio    = ${ratios.en}\n` +
      `    local.ratio = ${ratios.local}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
