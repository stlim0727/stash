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

test('cleanTrailingUrlPunctuation strips Unicode quotes and CJK punctuation', () => {
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com”'), {
    url: 'https://example.com',
    trailing: '”',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com。'), {
    url: 'https://example.com',
    trailing: '。',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com，'), {
    url: 'https://example.com',
    trailing: '，',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com』'), {
    url: 'https://example.com',
    trailing: '』',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com）'), {
    url: 'https://example.com',
    trailing: '）',
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

test('cleanTrailingUrlPunctuation strips nested brackets and repeated closers', () => {
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com」』'), {
    url: 'https://example.com',
    trailing: '」』',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com].)'), {
    url: 'https://example.com',
    trailing: '].)',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com/path…'), {
    url: 'https://example.com/path',
    trailing: '…',
  });
  assert.deepEqual(
    cleanTrailingUrlPunctuation('https://example.com' + ')'.repeat(1000)),
    {
      url: 'https://example.com',
      trailing: ')'.repeat(1000),
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

test('parsePlainTextLinks splits adjacent URLs separated by punctuation delimiters', () => {
  const content = 'https://a.com,https://b.com;https://c.com、https://d.com';
  const segments = parsePlainTextLinks(content);
  assert.deepEqual(segments, [
    { type: 'link', text: 'https://a.com', url: 'https://a.com' },
    { type: 'text', text: ',' },
    { type: 'link', text: 'https://b.com', url: 'https://b.com' },
    { type: 'text', text: ';' },
    { type: 'link', text: 'https://c.com', url: 'https://c.com' },
    { type: 'text', text: '、' },
    { type: 'link', text: 'https://d.com', url: 'https://d.com' },
  ]);
  assert.equal(segments.map((s) => s.text).join(''), content);
});

test('parsePlainTextLinks handles nested bracket wrappers', () => {
  const content = '『「https://example.com」』 and (https://a.com)(https://b.com)';
  const segments = parsePlainTextLinks(content);
  assert.deepEqual(segments, [
    { type: 'text', text: '『「' },
    { type: 'link', text: 'https://example.com', url: 'https://example.com' },
    { type: 'text', text: '」』 and (' },
    { type: 'link', text: 'https://a.com', url: 'https://a.com' },
    { type: 'text', text: ')(' },
    { type: 'link', text: 'https://b.com', url: 'https://b.com' },
    { type: 'text', text: ')' },
  ]);
  assert.equal(segments.map((s) => s.text).join(''), content);
});

test('parsePlainTextLinks stops URL match before attached Korean prose on domain boundary', () => {
  const content = '링크는 https://keepory.app입니다 확인바랍니다';
  const segments = parsePlainTextLinks(content);
  assert.deepEqual(segments, [
    { type: 'text', text: '링크는 ' },
    { type: 'link', text: 'https://keepory.app', url: 'https://keepory.app' },
    { type: 'text', text: '입니다 확인바랍니다' },
  ]);
  assert.equal(segments.map((s) => s.text).join(''), content);

  const portCase = '포트: https://keepory.app:3000입니다';
  const portSegs = parsePlainTextLinks(portCase);
  assert.deepEqual(portSegs, [
    { type: 'text', text: '포트: ' },
    { type: 'link', text: 'https://keepory.app:3000', url: 'https://keepory.app:3000' },
    { type: 'text', text: '입니다' },
  ]);
  assert.equal(portSegs.map((s) => s.text).join(''), portCase);

  const idnCase = 'IDN: https://한글.com입니다';
  const idnSegs = parsePlainTextLinks(idnCase);
  assert.deepEqual(idnSegs, [
    { type: 'text', text: 'IDN: ' },
    { type: 'link', text: 'https://한글.com', url: 'https://한글.com' },
    { type: 'text', text: '입니다' },
  ]);
  assert.equal(idnSegs.map((s) => s.text).join(''), idnCase);

  const mapsCase = '지도: https://maps.app.goo.gl/hBX7aD55YpUUN7Ji6입니다';
  const mapsSegs = parsePlainTextLinks(mapsCase);
  assert.deepEqual(mapsSegs, [
    { type: 'text', text: '지도: ' },
    { type: 'link', text: 'https://maps.app.goo.gl/hBX7aD55YpUUN7Ji6', url: 'https://maps.app.goo.gl/hBX7aD55YpUUN7Ji6' },
    { type: 'text', text: '입니다' },
  ]);
  assert.equal(mapsSegs.map((s) => s.text).join(''), mapsCase);

  const wikiAppleCase = '위키: https://ko.wikipedia.org/wiki/사과';
  const wikiAppleSegs = parsePlainTextLinks(wikiAppleCase);
  assert.deepEqual(wikiAppleSegs, [
    { type: 'text', text: '위키: ' },
    { type: 'link', text: 'https://ko.wikipedia.org/wiki/사과', url: 'https://ko.wikipedia.org/wiki/사과' },
  ]);
  assert.equal(wikiAppleSegs.map((s) => s.text).join(''), wikiAppleCase);

  const middleKoreanCase = '경로: https://keepory.app입니다/path';
  const middleSegs = parsePlainTextLinks(middleKoreanCase);
  assert.deepEqual(middleSegs, [
    { type: 'text', text: '경로: ' },
    { type: 'link', text: 'https://keepory.app', url: 'https://keepory.app' },
    { type: 'text', text: '입니다/path' },
  ]);
  assert.equal(middleSegs.map((s) => s.text).join(''), middleKoreanCase);
});

test('parsePlainTextLinks handles large delimiter runs without quadratic stalling', () => {
  const content = 'https://x.com/' + ')'.repeat(10_000);
  const start = Date.now();
  const segments = parsePlainTextLinks(content);
  const duration = Date.now() - start;
  assert.ok(duration < 100, `Expected duration < 100ms, took ${duration}ms`);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].type, 'link');
  assert.equal(segments[0].text, 'https://x.com/');
  assert.equal(segments[1].type, 'text');
  assert.equal(segments[1].text, ')'.repeat(10_000));
  assert.equal(segments.map((s) => s.text).join(''), content);
});
