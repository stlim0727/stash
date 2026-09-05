import { markdownLabel, markdownToPlainText } from '@/domain/markdown';
import type { Bookmark, TextFormat } from '@/domain/types';

export function memoBodyFormat(bookmark: Pick<Bookmark, 'description_format'>): TextFormat {
  return bookmark.description_format ?? 'markdown';
}

export function notesFormat(bookmark: Pick<Bookmark, 'notes_format'>): TextFormat {
  return bookmark.notes_format ?? 'plain';
}

/** Only Markdown is parsed; plain text keeps literal syntax in lists and search. */
export function textForDisplay(text: string | null | undefined, format: TextFormat): string {
  return format === 'markdown' ? markdownToPlainText(text) : (text ?? '');
}

export function memoBodyLabel(bookmark: Pick<Bookmark, 'description' | 'description_format'>): string | null {
  if (memoBodyFormat(bookmark) === 'markdown') {
    return markdownLabel(bookmark.description);
  }
  return bookmark.description?.split(/\r?\n/).find((line) => line.trim())?.trim() || null;
}

export function parseTextFormat(value: unknown): TextFormat | undefined {
  return value === 'plain' || value === 'markdown' ? value : undefined;
}
