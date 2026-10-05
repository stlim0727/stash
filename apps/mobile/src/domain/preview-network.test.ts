import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPublicPreview, isPublicPreviewUrl } from './preview-network.ts';
import { fetchPageMetadata, parsePageMetadata, discoverOembedEndpoint } from './page-metadata.ts';

test('automatic preview rejects local networks and URL parser IP aliases', () => {
  for (const url of [
    'http://localhost', 'http://a.localhost./', 'http://printer.local',
    'http://10.1.2.3', 'http://172.16.0.1', 'http://192.168.1.1',
    'http://169.254.169.254', 'http://100.64.0.1', 'http://127.1',
    'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1',
    'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://[64:ff9b::7f00:1]',
    'https://user:password@example.com', 'https://example.com:8080',
    'file:///etc/passwd', 'data:text/html,test', 'javascript:alert(1)',
  ]) assert.equal(isPublicPreviewUrl(url), false, url);
  for (const url of ['https://example.com/a', 'https://naver.me/a', 'https://8.8.8.8', 'https://例え.jp']) {
    assert.equal(isPublicPreviewUrl(url), true, url);
  }
});

test('private page and oEmbed/image targets never become automatic requests', async () => {
  assert.equal(await fetchPageMetadata('http://127.0.0.1/secret'), null);
  const html = '<link rel="alternate" type="application/json+oembed" href="http://169.254.169.254/latest">' +
    '<meta property="og:image" content="http://192.168.1.1/admin">';
  assert.equal(discoverOembedEndpoint(html, 'https://example.com'), null);
  assert.equal(parsePageMetadata(html, 'https://example.com').preview_image_url, undefined);
});

test('redirect to private IP is stopped before a second request', async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  }) as typeof fetch;
  await assert.rejects(fetchPublicPreview('https://example.com', {}, fetcher));
  assert.equal(calls.length, 1);
});

test('public relative redirects work and loops are bounded', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return calls === 1 ? new Response(null, { status: 301, headers: { location: '/landed' } }) : new Response('ok');
  }) as typeof fetch;
  assert.equal(await (await fetchPublicPreview('https://example.com', {}, fetcher)).text(), 'ok');
  assert.equal(calls, 2);
  calls = 0;
  const loop = (async () => { calls += 1; return new Response(null, { status: 302, headers: { location: '/' } }); }) as typeof fetch;
  await assert.rejects(fetchPublicPreview('https://example.com/', {}, loop));
  assert.equal(calls, 1);
});

test('hidden browser redirects fail closed and long redirect chains stop', async () => {
  const hidden = (async () => ({ type: 'opaqueredirect' } as Response)) as typeof fetch;
  await assert.rejects(fetchPublicPreview('https://example.com', {}, hidden));
  let calls = 0;
  const endless = (async () => {
    calls += 1;
    return new Response(null, { status: 307, headers: { location: `/hop-${calls}` } });
  }) as typeof fetch;
  await assert.rejects(fetchPublicPreview('https://example.com', {}, endless));
  assert.equal(calls, 6);
});


test('home.arpa apex and subdomains never become preview requests', async () => {
  let requests = 0;
  const fetcher = (async () => { requests += 1; return new Response('unexpected'); }) as typeof fetch;
  for (const url of ['http://home.arpa/path', 'https://HOME.ARPA./path', 'http://router.home.arpa/path']) {
    assert.equal(isPublicPreviewUrl(url), false, url);
    await assert.rejects(fetchPublicPreview(url, {}, fetcher));
  }
  assert.equal(requests, 0);
  const redirect = (async () => { requests += 1; return new Response(null, { status: 302, headers: { location: 'http://home.arpa/private' } }); }) as typeof fetch;
  await assert.rejects(fetchPublicPreview('https://example.com', {}, redirect));
  assert.equal(requests, 1);
});

test('192 protocol and documentation exclusions stop at their /24 boundaries', () => {
  for (const ip of ['192.0.0.0', '192.0.0.255', '192.0.2.0', '192.0.2.255', '192.168.0.0', '192.168.255.255']) {
    assert.equal(isPublicPreviewUrl(`https://${ip}/image`), false, ip);
  }
  for (const ip of ['192.0.1.0', '192.0.1.255', '192.0.3.0', '192.0.255.255', '192.2.0.0', '192.2.1.1', '192.2.255.255']) {
    assert.equal(isPublicPreviewUrl(`https://${ip}/image`), true, ip);
  }
});
