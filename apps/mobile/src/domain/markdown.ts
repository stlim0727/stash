import { lexer, type Token, type Tokens } from 'marked';

const COMMON_HTML_TAG =
  /<\/?(?:a|abbr|b|blockquote|br|code|del|div|em|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|s|span|strong|sub|sup|table|td|th|tr|u|ul)(?:\s[^<>]*)?\/?>/gi;

/**
 * Project parsed Markdown to readable text.
 *
 * Using the syntax tree matters for legacy URL-less shares: unmatched `*`,
 * comparison operators, and angle-bracket generics are ordinary authored text,
 * not formatting characters to erase. HTML-looking spans are retained verbatim
 * for the same reason; only nodes the parser actually recognized as Markdown
 * lose their markup.
 */
function tokenText(token: Token): string {
  switch (token.type) {
    case 'text':
      return (token as Tokens.Text).tokens?.map(tokenText).join('') ?? token.text;
    case 'codespan':
    case 'code':
    case 'escape':
      return token.text;
    case 'html':
      // Marked also classifies unknown angle-bracket text such as `<string>`
      // as HTML. Strip only known tags inside the parsed HTML node so actual
      // markup is flattened without corrupting technical prose.
      return token.text.replace(COMMON_HTML_TAG, '');
    case 'image':
      return token.text.trim() || 'Image';
    case 'checkbox':
    case 'def':
    case 'hr':
      return '';
    case 'br':
    case 'space':
      return '\n';
    case 'blockquote':
      return (token as Tokens.Blockquote).tokens.map(tokenText).join('\n');
    case 'list':
      return (token as Tokens.List).items.map(tokenText).join('\n');
    case 'list_item':
      // A list item's own tokens are block-level (its leading text/paragraph
      // plus any nested list or continuation paragraph for a loose item), not
      // an inline run — joining with '' merges unrelated words together, e.g.
      // "Parent item" + "Child item" becoming "Parent itemChild item".
      return (token as Tokens.ListItem).tokens.map(tokenText).join('\n');
    case 'table': {
      const table = token as Tokens.Table;
      return [table.header, ...table.rows]
        .map((row) => row.map((cell) => cell.tokens.map(tokenText).join('')).join(' '))
        .join('\n');
    }
    default:
      return (token as Tokens.Generic).tokens?.map(tokenText).join('') ?? '';
  }
}

/** Convert Markdown to readable plain text without mutating or guessing at ordinary syntax. */
export function markdownToPlainText(markdown: string | null | undefined): string {
  if (!markdown?.trim()) {
    return '';
  }

  try {
    return lexer(markdown).map(tokenText).join('\n').replace(/\s+/g, ' ').trim();
  } catch {
    // A malformed document should remain readable and intact. Parsing ordinary
    // user text is best-effort; never fall back to character-stripping regexes.
    return markdown.replace(/\s+/g, ' ').trim();
  }
}

/** The first meaningful rendered line, flattened for compact labels. */
export function markdownLabel(markdown: string | null | undefined): string | null {
  if (!markdown?.trim()) {
    return null;
  }
  try {
    // Parse the full document so shortcut reference links can resolve against
    // definitions declared later, then choose the first rendered block.
    for (const token of lexer(markdown)) {
      const plain = tokenText(token).replace(/\s+/g, ' ').trim();
      if (plain) {
        return plain;
      }
    }
  } catch {
    for (const line of markdown.split(/\r?\n/)) {
      const plain = line.replace(/\s+/g, ' ').trim();
      if (plain) {
        return plain;
      }
    }
  }
  return null;
}

function childTokens(token: Token): Token[] {
  if (token.type === 'list') {
    return (token as Tokens.List).items;
  }
  if (token.type === 'table') {
    const table = token as Tokens.Table;
    return [table.header, ...table.rows].flatMap((row) =>
      row.flatMap((cell) => cell.tokens),
    );
  }
  return (token as Tokens.Generic).tokens ?? [];
}

/** Rewrite parsed child spans while copying every byte between them verbatim. */
function rewriteTokenSequence(source: string, tokens: Token[]): string {
  let cursor = 0;
  let result = '';
  for (const token of tokens) {
    const index = source.indexOf(token.raw, cursor);
    if (index < 0) {
      continue;
    }
    result += source.slice(cursor, index);
    result += rewriteToken(token);
    cursor = index + token.raw.length;
  }
  return result + source.slice(cursor);
}

function rewriteToken(token: Token): string {
  if (token.type === 'image') {
    return token.text.trim() || 'Image';
  }
  const children = childTokens(token);
  return children.length > 0 ? rewriteTokenSequence(token.raw, children) : token.raw;
}

/**
 * Neutralize actual parsed image nodes before rendering so opening a memo never
 * fetches an arbitrary tracker. This handles inline and reference-style images
 * while leaving image-looking source inside code spans/blocks untouched.
 */
export function markdownForDisplay(markdown: string): string {
  try {
    return rewriteTokenSequence(markdown, lexer(markdown));
  } catch {
    // Fail closed if parsing ever rejects: escaping every image opener keeps the
    // authored text visible without letting the renderer interpret a fetchable
    // image node.
    return markdown.replace(/!\[/g, '\\![');
  }
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
