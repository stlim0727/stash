// Reusable scaffold for the `ui-preview` skill: hand-draw a React Native screen
// as SVG (from the real palette + layout values) and rasterize to a PNG with no
// emulator/browser. Copy this into apps/mobile/, edit PALETTE + STATES + the
// panel() drawing to match your component, then:
//
//   pnpm --filter mobile add -D @resvg/resvg-js   # once
//   node apps/mobile/<this-file>.mjs              # run from the mobile workspace
//
// Output: /tmp/ui-preview.png (2x scale). Caveats: icons/font/shadows are
// stylized stand-ins; colors/spacing/copy/structure are faithful.
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';

// 1) Paste the real palette from apps/mobile/src/theme.ts (light or dark).
const PALETTE = {
  bg: '#f7f9fc',
  card: '#ffffff',
  border: '#e6eaf0',
  text: '#101828',
  textSecondary: '#667085',
  muted: '#eef4ff',
  surface: '#ffffff',
  accent: '#208aef',
  accentSoft: '#d9ecff',
  accentText: '#0f5ea8',
};
const P = PALETTE;
const FONT = 'DejaVu Sans'; // must be a family `fc-list` reports as present
const SCREEN_W = 360; // a phone content column
const CARD_W = SCREEN_W - 32; // 16pt screen padding each side

// ---- SVG helpers ----------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const txt = (x, y, s, { size = 14, color = P.text, weight = 400, anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`;

/** Stylized circular-arrow glyph (e.g. sync/refresh). Set `double` for two arrows. */
function circArrow(cx, cy, r, color, double = false) {
  const out = [
    `<path d="M ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx} ${cy - r}" fill="none" stroke="${color}" stroke-width="2"/>`,
    `<path d="M ${cx - 3.5} ${cy - r} L ${cx + 1.5} ${cy - r - 3} L ${cx + 1.5} ${cy - r + 3} Z" fill="${color}"/>`,
  ];
  if (double) {
    out.push(
      `<path d="M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx} ${cy + r}" fill="none" stroke="${color}" stroke-width="2"/>`,
      `<path d="M ${cx + 3.5} ${cy + r} L ${cx - 1.5} ${cy + r + 3} L ${cx - 1.5} ${cy + r - 3} Z" fill="${color}"/>`,
    );
  }
  return out.join('');
}

/** Full-width pill (ghost button). */
function pillButton(x, y, w, label, h = 50) {
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="none" stroke="${P.border}" stroke-width="1"/>` +
    txt(x + w / 2, y + h / 2 + 6, label, { size: 16, weight: 700, anchor: 'middle' })
  );
}

// 2) Describe the states you want side by side.
const STATES = [
  { title: 'State A', heading: 'Example heading', sub: 'Supporting copy', buttons: ['Primary action'] },
  { title: 'State B', heading: 'Another state', sub: 'Different copy', buttons: [] },
];

// 3) Draw one panel. Replace the body with your component's structure, using
//    real padding/radius/font numbers from its StyleSheet.
function panel(ox, st) {
  const screenTop = 64;
  const cardX = ox + 16;
  const cardTop = screenTop + 16;
  const headerH = 88;
  const actionsH = st.buttons.length ? 28 + st.buttons.length * 62 - 12 : 0;
  const cardH = headerH + actionsH;

  const parts = [
    txt(ox + SCREEN_W / 2, screenTop - 18, st.title, { size: 16, weight: 700, anchor: 'middle' }),
    `<rect x="${ox}" y="${screenTop}" width="${SCREEN_W}" height="${cardH + 32}" rx="20" fill="${P.bg}"/>`,
    `<rect x="${cardX}" y="${cardTop}" width="${CARD_W}" height="${cardH}" rx="24" fill="${P.card}" stroke="${P.border}"/>`,
    txt(cardX + 16, cardTop + 40, st.heading, { size: 17, weight: 700 }),
    txt(cardX + 16, cardTop + 62, st.sub, { size: 13, color: P.textSecondary }),
  ];
  if (st.buttons.length) {
    parts.push(`<line x1="${cardX}" y1="${cardTop + headerH}" x2="${cardX + CARD_W}" y2="${cardTop + headerH}" stroke="${P.border}"/>`);
    let by = cardTop + headerH + 14;
    for (const label of st.buttons) {
      parts.push(pillButton(cardX + 16, by, CARD_W - 32, label));
      by += 62;
    }
  }
  return parts.join('\n');
}

// ---- compose + rasterize --------------------------------------------------
const gutter = 24;
const totalW = gutter + STATES.length * (SCREEN_W + gutter);
const totalH = 460;
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}">` +
  `<rect width="${totalW}" height="${totalH}" fill="#ffffff"/>` +
  STATES.map((st, i) => panel(gutter + i * (SCREEN_W + gutter), st)).join('\n') +
  `</svg>`;

const png = new Resvg(svg, { fitTo: { mode: 'width', value: totalW * 2 } }).render().asPng();
writeFileSync('/tmp/ui-preview.png', png);
console.log('wrote /tmp/ui-preview.png', png.length, 'bytes;', totalW, 'x', totalH);
