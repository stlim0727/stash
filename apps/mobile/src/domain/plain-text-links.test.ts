import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cleanTrailingUrlPunctuation, parsePlainTextLinks } from './plain-text-links.ts';

test('cleanTrailingUrlPunctuation strips basic punctuation', () => {
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com.'), {
    url: 'https://example.com',
    trailing: '.',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com,;:!?'), {
    url: 'https://example.com',
    trailing: ',;:!?',
  });
});

test('cleanTrailingUrlPunctuation preserves balanced parens while stripping unbalanced parens', () => {
  assert.deepEqual(
    cleanTrailingUrlPunctuation('https://en.wikipedia.org/wiki/React_(software)'),
    {
      url: 'https://en.wikipedia.org/wiki/React_(software)',
      trailing: '',
    },
  );
  assert.deepEqual(
    cleanTrailingUrlPunctuation('https://example.com)'),
    {
      url: 'https://example.com',
      trailing: ')',
    },
  );
  assert.deepEqual(
    cleanTrailingUrlPunctuation('https://example.com]'),
    {
      url: 'https://example.com',
      trailing: ']',
    },
  );
});

test('parsePlainTextLinks returns empty array for empty string', () => {
  assert.deepEqual(parsePlainTextLinks(''), []);
});

test('parsePlainTextLinks returns single text segment when no URLs exist', () => {
  const content = 'Hello world, this is a plain note without any links.';
  assert.deepEqual(parsePlainTextLinks(content), [
    { type: 'text', text: content },
  ]);
});

test('parsePlainTextLinks preserves exact string identity invariant', () => {
  const cases = [
    'Simple text',
    'Visit https://keepory.app for details.',
    'Links: (https://a.com) and [https://b.com/path?q=1#h] and {https://c.com}.',
    'Multiple lines:\nhttps://maps.app.goo.gl/123\nMore text\nhttps://maps.app.goo.gl/456\nEnd.',
    '# Heading with [link](https://example.com) inside markdown syntax',
    'Quotes "https://example.com" and \'https://test.org\'',
    'Trailing paren in wikipedia https://en.wikipedia.org/wiki/Function_(mathematics).',
  ];

  for (const text of cases) {
    const segments = parsePlainTextLinks(text);
    const reconstructed = segments.map((s) => s.text).join('');
    assert.equal(reconstructed, text, `Invariant failed for: "${text}"`);
  }
});

test('parsePlainTextLinks parses restaurant list like Hanoi user report', () => {
  const content = `최고의 소고기 국수 스프
https://maps.app.goo.gl/hBX7aD55YpUUN7Ji6

반꾸옹(쌀로 만든 롤 케이크)
https://maps.app.goo.gl/R3Mxw5xW6jMHzoB88`;

  const segments = parsePlainTextLinks(content);
  assert.equal(segments.length, 4);
  assert.deepEqual(segments[0], {
    type: 'text',
    text: '최고의 소고기 국수 스프\n',
  });
  assert.deepEqual(segments[1], {
    type: 'link',
    text: 'https://maps.app.goo.gl/hBX7aD55YpUUN7Ji6',
    url: 'https://maps.app.goo.gl/hBX7aD55YpUUN7Ji6',
  });
  assert.deepEqual(segments[2], {
    type: 'text',
    text: '\n\n반꾸옹(쌀로 만든 롤 케이크)\n',
  });
  assert.deepEqual(segments[3], {
    type: 'link',
    text: 'https://maps.app.goo.gl/R3Mxw5xW6jMHzoB88',
    url: 'https://maps.app.goo.gl/R3Mxw5xW6jMHzoB88',
  });
  assert.equal(segments.map((s) => s.text).join(''), content);
});

test('parsePlainTextLinks ignores unsafe schemes like javascript: or file:', () => {
  const content = 'Click javascript:alert(1) or file:///etc/passwd';
  assert.deepEqual(parsePlainTextLinks(content), [
    { type: 'text', text: content },
  ]);
});
