import assert from 'node:assert/strict';
import test from 'node:test';

import { runImportBatchTransactions } from '@/storage/import-batch';

test('organization metadata and imports beyond 50 rows share one transaction', async () => {
  const durable = { rows: [] as number[], meta: new Map<string, string>() };
  let transactions = 0;

  await assert.rejects(
    runImportBatchTransactions({
      bookmarks: Array.from({ length: 51 }, (_, index) => index),
      entries: Array.from({ length: 51 }, (_, index) => index),
      metaUpdates: { pending_import_collections: '[all 51 ids]' },
      transaction: async (work) => {
        transactions += 1;
        const rowsBefore = [...durable.rows];
        const metaBefore = new Map(durable.meta);
        try {
          await work();
        } catch (error) {
          durable.rows = rowsBefore;
          durable.meta = metaBefore;
          throw error;
        }
      },
      writeMeta: async (key, value) => {
        durable.meta.set(key, value);
      },
      writePair: async (bookmark) => {
        if (bookmark === 50) {
          throw new Error('process stopped at second legacy chunk');
        }
        durable.rows.push(bookmark);
      },
    }),
    /process stopped/,
  );

  assert.equal(transactions, 1);
  assert.deepEqual(durable.rows, []);
  assert.equal(durable.meta.size, 0);
});

test('imports without organization metadata retain bounded transactions', async () => {
  let transactions = 0;
  const rows: number[] = [];
  await runImportBatchTransactions({
    bookmarks: Array.from({ length: 51 }, (_, index) => index),
    entries: Array.from({ length: 51 }, (_, index) => index),
    transaction: async (work) => {
      transactions += 1;
      await work();
    },
    writeMeta: async () => {},
    writePair: async (bookmark) => {
      rows.push(bookmark);
    },
  });

  assert.equal(transactions, 2);
  assert.equal(rows.length, 51);
});
