import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFeedbackHandler } from './handler.ts';
import type { ReportSink } from './sink.ts';

const payload = JSON.stringify({ record: { id: 'report-1', user_id: 'user-1', message: 'feedback' } });
function request(secret?: string, body = payload) {
  return new Request('https://example.test', { method: 'POST', body, headers: secret ? { 'x-feedback-bridge-secret': secret } : {} });
}

test('missing/wrong webhook secrets never parse or deliver, with or without a destination', async () => {
  let deliveries = 0;
  const sink: ReportSink = { name: 'fake', async deliver() { deliveries++; return { delivered: true }; } };
  for (const target of [null, sink]) {
    assert.equal((await createFeedbackHandler('', target)(request())).status, 503);
    assert.equal((await createFeedbackHandler('', target)(request('guess'))).status, 503);
    for (const secret of [undefined, 'wrong', 'secre', 'secret-too-long']) {
      assert.equal((await createFeedbackHandler('secret', target)(request(secret, 'invalid-json'))).status, 401);
    }
  }
  assert.equal(deliveries, 0);
  assert.equal((await createFeedbackHandler('secret', sink)(request('secret'))).status, 200);
  assert.equal(deliveries, 1);
});

test('an authorized oversized webhook cannot reach the external destination', async () => {
  let deliveries = 0;
  const handler = createFeedbackHandler('secret', { name: 'fake', async deliver() { deliveries++; return { delivered: true }; } });
  const result = await handler(request('secret', JSON.stringify({ record: { id: 'r', message: 'x'.repeat(2 * 1024 * 1024) } })));
  assert.equal(result.status, 413);
  assert.equal(deliveries, 0);
});

test('the existing bounded screenshot attachment still fits the webhook boundary', async () => {
  let deliveries = 0;
  const handler = createFeedbackHandler('secret', { name: 'fake', async deliver() { deliveries++; return { delivered: true }; } });
  const body = JSON.stringify({ record: { id: 'r', message: 'feedback', context: { screenshot: { dataUrl: 'x'.repeat(1_500_000) } } } });
  assert.equal((await handler(request('secret', body))).status, 200);
  assert.equal(deliveries, 1);
});
