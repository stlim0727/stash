export const IMPORT_BATCH_SIZE = 50;

interface ImportBatchTransactionOptions<TBookmark, TEntry> {
  bookmarks: TBookmark[];
  entries: TEntry[];
  metaUpdates?: Record<string, string>;
  transaction: (work: () => Promise<void>) => Promise<void>;
  writeMeta: (key: string, value: string) => Promise<void>;
  writePair: (bookmark: TBookmark, entry: TEntry) => Promise<void>;
}

/**
 * Keep organization outboxes atomic with every bookmark they reference.
 * Imports without outboxes retain bounded transactions for responsiveness.
 */
export async function runImportBatchTransactions<TBookmark, TEntry>({
  bookmarks,
  entries,
  metaUpdates,
  transaction,
  writeMeta,
  writePair,
}: ImportBatchTransactionOptions<TBookmark, TEntry>): Promise<void> {
  const writeRange = async (offset: number, end: number) => {
    for (let index = offset; index < end; index += 1) {
      await writePair(bookmarks[index], entries[index]);
    }
  };

  if (metaUpdates) {
    await transaction(async () => {
      for (const [key, value] of Object.entries(metaUpdates)) {
        await writeMeta(key, value);
      }
      await writeRange(0, bookmarks.length);
    });
    return;
  }

  for (let offset = 0; offset < bookmarks.length; offset += IMPORT_BATCH_SIZE) {
    await transaction(() =>
      writeRange(offset, Math.min(offset + IMPORT_BATCH_SIZE, bookmarks.length)),
    );
  }
}
