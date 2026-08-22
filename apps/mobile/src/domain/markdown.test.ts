import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isSafeMarkdownLink,
  markdownForDisplay,
  markdownLabel,
  markdownToPlainText,
} from './markdown.ts';

test('markdownToPlainText keeps content while removing supported formatting syntax', () => {
  assert.equal(
    markdownToPlainText('# Plan\n\n- [x] **Ship** [Keepory](https://keepory.app)\n> safely'),
    'Plan Ship Keepory safely',
  );
});

test('markdownLabel returns the first meaningful rendered line', () => {
  assert.equal(markdownLabel('\n# Weekly **plan**\n\nDetails'), 'Weekly plan');
  assert.equal(markdownLabel('  '), null);
  assert.equal(markdownLabel(null), null);
});

test('plain text remains unchanged because legacy notes are valid Markdown', () => {
  assert.equal(markdownToPlainText('내일 3시에 회의 있습니다'), '내일 3시에 회의 있습니다');
});

test('markdownForDisplay keeps alt text without loading a remote image', () => {
  assert.equal(
    markdownForDisplay('Before ![diagram](https://tracker.example/pixel.png) after'),
    'Before diagram after',
  );
});

test('rendered Markdown only opens ordinary web links', () => {
  assert.equal(isSafeMarkdownLink('https://keepory.app'), true);
  assert.equal(isSafeMarkdownLink('http://localhost:8080/note'), true);
  assert.equal(isSafeMarkdownLink('javascript:alert(1)'), false);
  assert.equal(isSafeMarkdownLink('file:///secret'), false);
  assert.equal(isSafeMarkdownLink('not a url'), false);
});
