import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJsonObject, RequestBodyError } from './http.ts';

test('JSON size boundary checks streamed bytes even with a false Content-Length', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    const request = new Request('https://example.test', { method: 'POST', headers, body: JSON.stringify({ data: 'x'.repeat(40) }) });
    await assert.rejects(readJsonObject(request, 16), (error: unknown) => error instanceof RequestBodyError && error.status === 413);
  }
});

test('JSON body rejects arrays, scalars, null, invalid JSON and accepts an object', async () => {
  for (const body of ['[]', 'null', '42', '"text"', '{']) {
    await assert.rejects(readJsonObject(new Request('https://example.test', { method: 'POST', body })), RequestBodyError);
  }
  assert.deepEqual(await readJsonObject(new Request('https://example.test', { method: 'POST', body: '{"ok":true}' })), { ok: true });
});

test('a body that never completes is canceled at the request deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  const request = new Request('https://example.test', { method: 'POST', body, duplex: 'half' } as RequestInit);
  const result = readJsonObject(request);
  const rejected = assert.rejects(result, (error: unknown) => error instanceof RequestBodyError && error.status === 408);
  t.mock.timers.tick(5_001);
  await rejected;
  assert.equal(canceled, true);
});
