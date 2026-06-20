import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attachmentObjectPath,
  feedbackStatusLabel,
  isClosedStatus,
  normalizeFeedbackStatus,
  sanitizeFilename,
  summarizeReportForTester,
} from '@/domain/feedback';
import type { FeedbackReportRow } from '@/domain/feedback';

function rowFixture(overrides: Partial<FeedbackReportRow> = {}): FeedbackReportRow {
  return {
    id: 'r1',
    user_id: 'u1',
    category: 'bug',
    message: 'It crashed',
    context: { route: '/inbox' } as Record<string, unknown>,
    attachments: [{ path: 'u1/r1/0-shot.png' }],
    status: 'in_progress',
    developer_reply: 'Thanks, looking into it.',
    resolution: null,
    external_ref: 'https://github.com/acme/app/issues/42',
    created_at: '2026-06-20T00:00:00.000Z',
    updated_at: '2026-06-20T01:00:00.000Z',
    ...overrides,
  };
}

test('feedbackStatusLabel maps known statuses and defaults unknown ones', () => {
  assert.equal(feedbackStatusLabel('in_progress'), 'In progress');
  assert.equal(feedbackStatusLabel('resolved'), 'Resolved');
  assert.equal(feedbackStatusLabel('garbage'), 'Open');
  assert.equal(feedbackStatusLabel(null), 'Open');
});

test('normalizeFeedbackStatus falls back to open for unknown values', () => {
  assert.equal(normalizeFeedbackStatus('triaged'), 'triaged');
  assert.equal(normalizeFeedbackStatus('weird'), 'open');
  assert.equal(normalizeFeedbackStatus(undefined), 'open');
});

test('isClosedStatus is true only for resolved/closed', () => {
  assert.equal(isClosedStatus('resolved'), true);
  assert.equal(isClosedStatus('closed'), true);
  assert.equal(isClosedStatus('in_progress'), false);
  assert.equal(isClosedStatus('open'), false);
});

test('summarizeReportForTester drops internal fields (external_ref, context)', () => {
  const view = summarizeReportForTester(rowFixture());
  // Internal fields must not appear on the tester projection at all.
  const keys = view as unknown as Record<string, unknown>;
  assert.equal('external_ref' in keys, false);
  assert.equal('context' in keys, false);
  // Tester-facing fields are carried through.
  assert.equal(view.status, 'in_progress');
  assert.equal(view.statusLabel, 'In progress');
  assert.equal(view.developerReply, 'Thanks, looking into it.');
  assert.equal(view.resolution, null);
  assert.equal(view.attachmentCount, 1);
  assert.equal(view.category, 'bug');
});

test('summarizeReportForTester normalizes blanks and bad enums', () => {
  const view = summarizeReportForTester(
    rowFixture({
      category: 'nonsense',
      status: 'nonsense',
      developer_reply: '   ',
      resolution: 'Fixed in 0.2.1',
      attachments: undefined,
      updated_at: '',
    }),
  );
  assert.equal(view.category, 'bug');
  assert.equal(view.status, 'open');
  assert.equal(view.developerReply, null);
  assert.equal(view.resolution, 'Fixed in 0.2.1');
  assert.equal(view.attachmentCount, 0);
  assert.equal(view.updatedAt, null);
});

test('sanitizeFilename strips paths and unsafe characters', () => {
  assert.equal(sanitizeFilename('/tmp/My Photo (1).png'), 'My_Photo_1_.png');
  assert.equal(sanitizeFilename('   '), 'attachment');
  assert.equal(sanitizeFilename('réport.mp4'), 'r_port.mp4');
});

test('attachmentObjectPath namespaces by user then report', () => {
  const path = attachmentObjectPath({
    userId: 'user-1',
    reportId: 'rep-9',
    index: 2,
    filename: 'screen recording.mov',
  });
  assert.equal(path, 'user-1/rep-9/2-screen_recording.mov');
  // The first segment is the owner id, which the Storage RLS policy keys on.
  assert.equal(path.split('/')[0], 'user-1');
});
