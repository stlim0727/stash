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

test('markdownLabel flattens a shortcut reference link whose definition is on a later line', () => {
  assert.equal(markdownLabel('[Keepory]\n\n[Keepory]: https://example.com'), 'Keepory');
});

test('ordinary operators and HTML-looking generics are not stripped from legacy text', () => {
  for (const text of ['2 * 3 = 6', 'Array<string>', 'x < y and y > z']) {
    assert.equal(markdownToPlainText(text), text);
  }
  assert.equal(markdownToPlainText('<strong>Important</strong>'), 'Important');
});

test('plain text remains unchanged because legacy notes are valid Markdown', () => {
  assert.equal(markdownToPlainText('내일 3시에 회의 있습니다'), '내일 3시에 회의 있습니다');
});

test('markdownToPlainText preserves ordinary punctuation that is not a matched Markdown pair', () => {
  assert.equal(markdownToPlainText('2 * 3 = 6'), '2 * 3 = 6');
  assert.equal(markdownToPlainText('x < y and y > z'), 'x < y and y > z');
  assert.equal(markdownToPlainText('my_var_name is snake_case'), 'my_var_name is snake_case');
});

test('markdownToPlainText flattens reference-style links and drops their definition', () => {
  assert.equal(
    markdownToPlainText('[Keepory][site]\n\n[site]: https://example.com'),
    'Keepory',
  );
  assert.equal(
    markdownToPlainText('[Keepory][]\n\n[Keepory]: https://example.com'),
    'Keepory',
  );
  // Ordinary bracketed prose (not a reference-style link) stays untouched.
  assert.equal(markdownToPlainText('see item [1] in the list'), 'see item [1] in the list');
});

test('markdownToPlainText flattens shortcut reference links only when a matching definition exists', () => {
  assert.equal(
    markdownToPlainText('[Keepory]\n\n[Keepory]: https://example.com'),
    'Keepory',
  );
  // No matching definition anywhere in the document — treated as ordinary
  // bracketed prose, not a link.
  assert.equal(markdownToPlainText('[TODO] fix this later'), '[TODO] fix this later');
});

test('markdownForDisplay keeps alt text without loading a remote image', () => {
  assert.equal(
    markdownForDisplay('Before ![diagram](https://tracker.example/pixel.png) after'),
    'Before diagram after',
  );
  assert.equal(
    markdownForDisplay('![pixel][tracker]\n\n[tracker]: https://tracker.example/pixel.png'),
    'pixel\n\n[tracker]: https://tracker.example/pixel.png',
  );
  assert.equal(
    markdownForDisplay('![pixel]\n\n[pixel]: https://tracker.example/pixel.png'),
    'pixel\n\n[pixel]: https://tracker.example/pixel.png',
  );
});

test('markdownForDisplay neutralizes reference images without rewriting their definition', () => {
  assert.equal(
    markdownForDisplay(
      'Before ![tracking pixel][tracker] after\n\n[tracker]: https://tracker.example/pixel.png',
    ),
    'Before tracking pixel after\n\n[tracker]: https://tracker.example/pixel.png',
  );
});

test('markdownForDisplay leaves image-looking text inside code untouched', () => {
  const markdown =
    '`![inline code](https://tracker.example/a.png)`\n\n```md\n![code block](https://tracker.example/b.png)\n```';
  assert.equal(markdownForDisplay(markdown), markdown);
});

test('rendered Markdown only opens ordinary web links', () => {
  assert.equal(isSafeMarkdownLink('https://keepory.app'), true);
  assert.equal(isSafeMarkdownLink('http://localhost:8080/note'), true);
  assert.equal(isSafeMarkdownLink('javascript:alert(1)'), false);
  assert.equal(isSafeMarkdownLink('file:///secret'), false);
  assert.equal(isSafeMarkdownLink('not a url'), false);
});
