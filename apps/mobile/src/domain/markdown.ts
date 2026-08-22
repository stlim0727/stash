/**
 * Read-side helpers for Markdown memo bodies.
 *
 * The stored value always remains the user's original Markdown. These helpers
 * create a compact plain-text projection only for list labels, graph nodes,
 * search-result previews, and accessibility. They deliberately cover the
 * supported Keepory subset instead of pretending to be a second renderer.
 */

/** Labels declared by a reference definition (`[label]: url`) in a document —
 * used to recognize a shortcut reference link (`[label]` with no separate
 * destination) without mistaking ordinary bracketed prose ("see item [1]")
 * for one. */
function collectReferenceLabels(markdown: string): Set<string> {
  const referenceLabels = new Set<string>();
  for (const match of markdown.matchAll(/^\s*\[([^\]]+)\]:\s*\S/gm)) {
    referenceLabels.add(match[1]!.trim().toLowerCase());
  }
  return referenceLabels;
}

/**
 * Convert supported Markdown syntax to readable plain text without mutating
 * the source. `referenceLabels`, when passed, is used instead of scanning
 * `markdown` itself for reference definitions — `markdownLabel` passes the
 * whole document's labels in when processing a single line at a time, since
 * a definition can live on a different line than its shortcut reference.
 */
export function markdownToPlainText(
  markdown: string | null | undefined,
  referenceLabels?: Set<string>,
): string {
  if (!markdown?.trim()) {
    return '';
  }

  const labels = referenceLabels ?? collectReferenceLabels(markdown);

  return markdown
    .replace(/```[^\n]*\n?/g, '')
    .replace(/~~~[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Full/collapsed reference-style links (`[text][ref]`, `[text][]`).
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // Shortcut reference links (`[label]` alone) — only when a matching
    // definition was actually found above.
    .replace(/\[([^\]]+)\](?!\(|\[|:)/g, (fullMatch, label: string) =>
      labels.has(label.trim().toLowerCase()) ? label : fullMatch,
    )
    // The (now-orphaned) reference definition line itself (`[ref]: url`) so
    // it doesn't linger in the projection as raw text.
    .replace(/^\s*\[[^\]]+\]:\s*\S.*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/gm, '')
    // Only strip a known common HTML tag name, not any `<letter...>` span —
    // that would also catch ordinary comparisons ("x < y and y > z") and
    // generic type syntax in technical notes ("Array<string>").
    .replace(
      /<\/?(?:a|abbr|b|blockquote|br|code|del|div|em|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|s|span|strong|sub|sup|table|td|th|tr|u|ul)(?:\s[^<>]*)?\/?>/gi,
      '',
    )
    // Only strip *matched pairs* of emphasis/code delimiters, not a lone
    // `*`/`_`/`~`/`` ` `` that just happens to appear in plain text (e.g.
    // "2 * 3 = 6"). Bold before italic so `**x**` isn't left as `*x*`.
    .replace(/\*\*([^\n]+?)\*\*/g, '$1')
    .replace(/(?<!\w)__([^\n]+?)__(?!\w)/g, '$1')
    .replace(/\*([^\n]+?)\*/g, '$1')
    .replace(/(?<!\w)_([^\n]+?)_(?!\w)/g, '$1')
    .replace(/~~([^\n]+?)~~/g, '$1')
    .replace(/`([^\n]+?)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first meaningful Markdown line, flattened for compact labels. */
export function markdownLabel(markdown: string | null | undefined): string | null {
  if (!markdown?.trim()) {
    return null;
  }
  // Scan the whole document once — a shortcut reference link's definition
  // can live on a different line than the link itself, so a per-line-only
  // scan (see markdownToPlainText's own fallback) would never see it.
  const referenceLabels = collectReferenceLabels(markdown);
  for (const line of markdown.split(/\r?\n/)) {
    const plain = markdownToPlainText(line, referenceLabels);
    if (plain) {
      return plain;
    }
  }
  return null;
}

/**
 * Remove network-backed image embeds from the rendered projection. The source
 * Markdown is preserved unchanged; MVP memo rendering supports links but must
 * not fetch an arbitrary tracking image just because a memo was opened.
 */
export function markdownForDisplay(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => alt || 'Image')
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, (_match, alt: string) => alt || 'Image')
    // Shortcut reference images (`![tracker]` + a `[tracker]: url` definition
    // elsewhere) — neutralize any remaining `![...]` not already handled
    // above, since it's otherwise indistinguishable from one without fully
    // parsing the document's reference definitions.
    .replace(/!\[([^\]]+)\](?!\(|\[)/g, (_match, alt: string) => alt || 'Image');
}

/** Only ordinary web links may leave a rendered memo. */
export function isSafeMarkdownLink(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
