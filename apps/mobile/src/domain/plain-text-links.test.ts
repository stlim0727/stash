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

test('cleanTrailingUrlPunctuation preserves punctuation inside query and fragment values', () => {
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com/search?q=Who?'), {
    url: 'https://example.com/search?q=Who?',
    trailing: '',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com/search?q=Who?.'), {
    url: 'https://example.com/search?q=Who?',
    trailing: '.',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com/items?filter=a,b;'), {
    url: 'https://example.com/items?filter=a,b;',
    trailing: '',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com/items?filter=a,b;.'), {
    url: 'https://example.com/items?filter=a,b;',
    trailing: '.',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com/tags?t=a,b,'), {
    url: 'https://example.com/tags?t=a,b,',
    trailing: '',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com/doc#faq?'), {
    url: 'https://example.com/doc#faq?',
    trailing: '',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com/doc#section;'), {
    url: 'https://example.com/doc#section;',
    trailing: '',
  });
  // Without query or fragment, punctuation is stripped as prose
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com/path?'), {
    url: 'https://example.com/path',
    trailing: '?',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com/path,'), {
    url: 'https://example.com/path',
    trailing: ',',
  });
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com/path;'), {
    url: 'https://example.com/path',
    trailing: ';',
  });
  // Authored single-segment path ending in Korean suffix is preserved
  assert.deepEqual(cleanTrailingUrlPunctuation('https://example.com/Windows에서'), {
    url: 'https://example.com/Windows에서',
    trailing: '',
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

  // Legitimate URL paths and queries ending in entries from KOREAN_MULTI_SYLLABLE_PROSE
  // (e.g. /wiki/이다 or ?q=보세요) must be preserved because they are preceded by URL
  // delimiters (/ or =), not by ASCII tokens.
  const wikiIsCase = '위키: https://ko.wikipedia.org/wiki/이다';
  const wikiIsSegs = parsePlainTextLinks(wikiIsCase);
  assert.deepEqual(wikiIsSegs, [
    { type: 'text', text: '위키: ' },
    { type: 'link', text: 'https://ko.wikipedia.org/wiki/이다', url: 'https://ko.wikipedia.org/wiki/이다' },
  ]);
  assert.equal(wikiIsSegs.map((s) => s.text).join(''), wikiIsCase);

  const queryLookCase = '검색: https://example.com/?q=보세요';
  const queryLookSegs = parsePlainTextLinks(queryLookCase);
  assert.deepEqual(queryLookSegs, [
    { type: 'text', text: '검색: ' },
    { type: 'link', text: 'https://example.com/?q=보세요', url: 'https://example.com/?q=보세요' },
  ]);
  assert.equal(queryLookSegs.map((s) => s.text).join(''), queryLookCase);

  // Mixed-language URLs like search?q=iPhone케이스 must preserve Hangul words
  const mixedIphoneCase = '검색: https://example.com/search?q=iPhone케이스';
  const mixedIphoneSegs = parsePlainTextLinks(mixedIphoneCase);
  assert.deepEqual(mixedIphoneSegs, [
    { type: 'text', text: '검색: ' },
    { type: 'link', text: 'https://example.com/search?q=iPhone케이스', url: 'https://example.com/search?q=iPhone케이스' },
  ]);
  assert.equal(mixedIphoneSegs.map((s) => s.text).join(''), mixedIphoneCase);

  // Mixed-language query parameters like search?q=Windows에서 must preserve the full query value
  const mixedWindowsCase = '검색: https://example.com/search?q=Windows에서';
  const mixedWindowsSegs = parsePlainTextLinks(mixedWindowsCase);
  assert.deepEqual(mixedWindowsSegs, [
    { type: 'text', text: '검색: ' },
    { type: 'link', text: 'https://example.com/search?q=Windows에서', url: 'https://example.com/search?q=Windows에서' },
  ]);
  assert.equal(mixedWindowsSegs.map((s) => s.text).join(''), mixedWindowsCase);

  // Korean IDN domains like https://예시.한국입니다 split cleanly at the IDN TLD boundary
  const idnKoreaCase = '도메인: https://예시.한국입니다 확인하세요';
  const idnKoreaSegs = parsePlainTextLinks(idnKoreaCase);
  assert.deepEqual(idnKoreaSegs, [
    { type: 'text', text: '도메인: ' },
    { type: 'link', text: 'https://예시.한국', url: 'https://예시.한국' },
    { type: 'text', text: '입니다 확인하세요' },
  ]);
  assert.equal(idnKoreaSegs.map((s) => s.text).join(''), idnKoreaCase);

  // Legitimate URL-significant punctuation in paths (e.g. Wikipedia article titles) is preserved
  const wikiYahooCase = '참고: https://en.wikipedia.org/wiki/Yahoo! 문서를 확인하세요.';
  const wikiYahooSegs = parsePlainTextLinks(wikiYahooCase);
  assert.deepEqual(wikiYahooSegs, [
    { type: 'text', text: '참고: ' },
    { type: 'link', text: 'https://en.wikipedia.org/wiki/Yahoo!', url: 'https://en.wikipedia.org/wiki/Yahoo!' },
    { type: 'text', text: ' 문서를 확인하세요.' },
  ]);
  assert.equal(wikiYahooSegs.map((s) => s.text).join(''), wikiYahooCase);

  // Trailing period after Wikipedia Yahoo! URL is stripped while preserving the exclamation mark
  const wikiYahooDotCase = '위키: https://en.wikipedia.org/wiki/Yahoo!.';
  const wikiYahooDotSegs = parsePlainTextLinks(wikiYahooDotCase);
  assert.deepEqual(wikiYahooDotSegs, [
    { type: 'text', text: '위키: ' },
    { type: 'link', text: 'https://en.wikipedia.org/wiki/Yahoo!', url: 'https://en.wikipedia.org/wiki/Yahoo!' },
    { type: 'text', text: '.' },
  ]);
  assert.equal(wikiYahooDotSegs.map((s) => s.text).join(''), wikiYahooDotCase);

  // Mixed-language URL ending in a syllable that happens to be a particle character (로 in 프로)
  // preceded by Hangul (프) must not strip the syllable
  const mixedMacBookCase = '노트북: https://example.com/item/MacBook프로';
  const mixedMacBookSegs = parsePlainTextLinks(mixedMacBookCase);
  assert.deepEqual(mixedMacBookSegs, [
    { type: 'text', text: '노트북: ' },
    { type: 'link', text: 'https://example.com/item/MacBook프로', url: 'https://example.com/item/MacBook프로' },
  ]);
  assert.equal(mixedMacBookSegs.map((s) => s.text).join(''), mixedMacBookCase);

  // ASCII token followed by attached single-syllable particle (e.g. 6로 or xyz과)
  const asciiParticleCase = '안내: https://maps.app.goo.gl/hBX7aD55YpUUN7Ji6로 가세요';
  const asciiParticleSegs = parsePlainTextLinks(asciiParticleCase);
  assert.deepEqual(asciiParticleSegs, [
    { type: 'text', text: '안내: ' },
    { type: 'link', text: 'https://maps.app.goo.gl/hBX7aD55YpUUN7Ji6', url: 'https://maps.app.goo.gl/hBX7aD55YpUUN7Ji6' },
    { type: 'text', text: '로 가세요' },
  ]);
  assert.equal(asciiParticleSegs.map((s) => s.text).join(''), asciiParticleCase);

  const middleKoreanCase = '경로: https://keepory.app입니다/path';
  const middleSegs = parsePlainTextLinks(middleKoreanCase);
  assert.deepEqual(middleSegs, [
    { type: 'text', text: '경로: ' },
    { type: 'link', text: 'https://keepory.app', url: 'https://keepory.app' },
    { type: 'text', text: '입니다/path' },
  ]);
  assert.equal(middleSegs.map((s) => s.text).join(''), middleKoreanCase);

  // Korean initial path segments (e.g. https://example.com/한국) must not be truncated
  const koreanInitialPathCase = '참고: https://example.com/한국 링크를 확인하세요';
  const koreanInitialPathSegs = parsePlainTextLinks(koreanInitialPathCase);
  assert.deepEqual(koreanInitialPathSegs, [
    { type: 'text', text: '참고: ' },
    { type: 'link', text: 'https://example.com/한국', url: 'https://example.com/한국' },
    { type: 'text', text: ' 링크를 확인하세요' },
  ]);
  assert.equal(koreanInitialPathSegs.map((s) => s.text).join(''), koreanInitialPathCase);

  // Legitimate query punctuation (question marks, semicolons) in query/fragment values must be preserved
  const queryQuestionCase = '질문: https://example.com/search?q=Who? 확인';
  const queryQuestionSegs = parsePlainTextLinks(queryQuestionCase);
  assert.deepEqual(queryQuestionSegs, [
    { type: 'text', text: '질문: ' },
    { type: 'link', text: 'https://example.com/search?q=Who?', url: 'https://example.com/search?q=Who?' },
    { type: 'text', text: ' 확인' },
  ]);
  assert.equal(queryQuestionSegs.map((s) => s.text).join(''), queryQuestionCase);

  const queryQuestionDotCase = '질문: https://example.com/search?q=Who?.';
  const queryQuestionDotSegs = parsePlainTextLinks(queryQuestionDotCase);
  assert.deepEqual(queryQuestionDotSegs, [
    { type: 'text', text: '질문: ' },
    { type: 'link', text: 'https://example.com/search?q=Who?', url: 'https://example.com/search?q=Who?' },
    { type: 'text', text: '.' },
  ]);
  assert.equal(queryQuestionDotSegs.map((s) => s.text).join(''), queryQuestionDotCase);

  const querySemicolonCase = '필터: https://example.com/items?filter=a,b; 그리고 다음';
  const querySemicolonSegs = parsePlainTextLinks(querySemicolonCase);
  assert.deepEqual(querySemicolonSegs, [
    { type: 'text', text: '필터: ' },
    { type: 'link', text: 'https://example.com/items?filter=a,b;', url: 'https://example.com/items?filter=a,b;' },
    { type: 'text', text: ' 그리고 다음' },
  ]);
  assert.equal(querySemicolonSegs.map((s) => s.text).join(''), querySemicolonCase);

  // Single-segment authored paths ending in Korean syllables (e.g. https://example.com/Windows에서)
  // must be preserved as authored path content rather than stripped as prose.
  const singleSegmentPathCase = '참고: https://example.com/Windows에서 확인하세요';
  const singleSegmentPathSegs = parsePlainTextLinks(singleSegmentPathCase);
  assert.deepEqual(singleSegmentPathSegs, [
    { type: 'text', text: '참고: ' },
    { type: 'link', text: 'https://example.com/Windows에서', url: 'https://example.com/Windows에서' },
    { type: 'text', text: ' 확인하세요' },
  ]);
  assert.equal(singleSegmentPathSegs.map((s) => s.text).join(''), singleSegmentPathCase);
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
