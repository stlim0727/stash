/**
 * Tag-cloud → SVG preview. A pure, dependency-free renderer that lays the cloud
 * out the way the app does (alphabetical so sizes intersperse; size, weight and
 * a stable per-tag color carry frequency) and emits a self-contained SVG.
 *
 * Why it exists: the on-device look otherwise only surfaces via the Android
 * emulator screenshot job. This gives a deterministic, unit-testable image of
 * the layout that any test run can emit as an artifact — no emulator needed.
 */
import { MONOGRAM_COLORS, monogramColorIndex } from './item-icon.ts';
import { tagCloudFontSize, type TagCloudEntry } from './tag-cloud.ts';

export interface TagCloudSvgOptions {
  /** Canvas width in px. Height grows to fit the wrapped rows. */
  width?: number;
  /** Inner margin around the words. */
  padding?: number;
  /** Page background (the rounded card behind the words). */
  background?: string;
  fontFamily?: string;
}

interface MeasuredWord {
  entry: TagCloudEntry;
  text: string;
  size: number;
  boxWidth: number;
}

const COLUMN_GAP = 16;
const ROW_GAP = 10;

/** Render the cloud entries as a standalone SVG document string. */
export function renderTagCloudSvg(entries: TagCloudEntry[], options: TagCloudSvgOptions = {}): string {
  const width = options.width ?? 760;
  const padding = options.padding ?? 28;
  const background = options.background ?? '#ffffff';
  const fontFamily = options.fontFamily ?? 'Helvetica, Arial, sans-serif';
  const innerWidth = width - padding * 2;

  // Display order matches the app: alphabetical, so big/small words intersperse
  // into a cloud rather than a frequency-sorted wedge.
  const words: MeasuredWord[] = [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const size = tagCloudFontSize(entry.weight);
      const text = `#${entry.name}`;
      // Rough advance width for a bold-ish sans glyph — enough to flow + center
      // rows without overlap (SVG text isn't measured, so we estimate).
      return { entry, text, size, boxWidth: Math.ceil(text.length * size * 0.62) };
    });

  // Greedily flow words into rows no wider than the inner width.
  const rows: MeasuredWord[][] = [];
  let row: MeasuredWord[] = [];
  let rowWidth = 0;
  for (const word of words) {
    const advance = (row.length === 0 ? 0 : COLUMN_GAP) + word.boxWidth;
    if (row.length > 0 && rowWidth + advance > innerWidth) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    rowWidth += (row.length === 0 ? 0 : COLUMN_GAP) + word.boxWidth;
    row.push(word);
  }
  if (row.length > 0) {
    rows.push(row);
  }

  const lines: string[] = [];
  let y = padding;
  for (const current of rows) {
    const rowHeight = Math.max(...current.map((w) => w.size));
    const totalWidth = current.reduce((sum, w, i) => sum + w.boxWidth + (i === 0 ? 0 : COLUMN_GAP), 0);
    // Center the row; words share a baseline so mixed sizes bottom-align.
    let x = padding + Math.max(0, (innerWidth - totalWidth) / 2);
    const baseline = y + rowHeight;
    for (const word of current) {
      const color = MONOGRAM_COLORS[monogramColorIndex(word.entry.name)];
      const fontWeight = word.entry.weight > 0.66 ? 800 : word.entry.weight > 0.33 ? 700 : 600;
      const opacity = (0.55 + 0.45 * word.entry.weight).toFixed(2);
      lines.push(
        `  <text x="${x.toFixed(1)}" y="${baseline.toFixed(1)}" font-family="${fontFamily}" ` +
          `font-size="${word.size}" font-weight="${fontWeight}" fill="${color}" fill-opacity="${opacity}" ` +
          `letter-spacing="-0.3">${escapeXml(word.text)}</text>`,
      );
      x += word.boxWidth + COLUMN_GAP;
    }
    y = baseline + ROW_GAP;
  }

  const height = rows.length === 0 ? padding * 2 : Math.ceil(y - ROW_GAP + padding);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" role="img" aria-label="Tag cloud preview">`,
    `  <rect width="${width}" height="${height}" rx="20" fill="${background}"/>`,
    ...lines,
    `</svg>`,
  ].join('\n');
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!,
  );
}
