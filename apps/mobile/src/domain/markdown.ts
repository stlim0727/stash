/**
 * Read-side helpers for Markdown memo bodies.
 *
 * The stored value always remains the user's original Markdown. These helpers
 * create a compact plain-text projection only for list labels, graph nodes,
 * search-result previews, and accessibility. They deliberately cover the
 * supported Keepory subset instead of pretending to be a second renderer.
 */

/** Convert supported Markdown syntax to readable plain text without mutating the source. */
export function markdownToPlainText(markdown: string | null | undefined): string {
  if (!markdown?.trim()) {
    return '';
  }

  return markdown
    .replace(/```[^\n]*\n?/g, '')
    .replace(/~~~[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/gm, '')
    // Only strip actual HTML-tag-like spans (`<tag ...>`), not ordinary
    // comparison operators such as "x < y and y > z".
    .replace(/<\/?[a-zA-Z][^<>]*>/g, '')
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
  for (const line of markdown.split(/\r?\n/)) {
    const plain = markdownToPlainText(line);
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
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, (_match, alt: string) => alt || 'Image');
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
