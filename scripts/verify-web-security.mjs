// Verify an Expo web export under the exported Cloudflare header policy.
// Usage: node scripts/verify-web-security.mjs /absolute/path/to/export [chrome]
// Runs only against loopback; blocks remote requests and removes its Chrome profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, resolve, sep } from 'node:path';

const exportRoot = resolve(process.argv[2] ?? 'apps/mobile/dist');
const headersFile = await readFile(join(exportRoot, '_headers'), 'utf8');
const headers = Object.fromEntries(headersFile.split('\n')
  .filter((line) => /^\s+[\w-]+:/.test(line))
  .map((line) => { const at = line.indexOf(':'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));
assert.equal(headers['X-Content-Type-Options'], 'nosniff');
assert.equal(headers['Referrer-Policy'], 'no-referrer');
assert.ok(headers['Content-Security-Policy']);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const probe = `
window.probe = {self: true, violations: []};
document.addEventListener('securitypolicyviolation', e => window.probe.violations.push(e.effectiveDirective));
try { eval('window.evalExecuted = true'); } catch { window.probe.evalBlocked = true; }
try { new Function('window.functionExecuted = true')(); } catch { window.probe.functionBlocked = true; }
WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => window.probe.wasm = true);
document.addEventListener('DOMContentLoaded', () => {
  const script = document.createElement('script');
  script.textContent = 'window.inlineExecuted = true'; document.body.append(script);
  const button = document.createElement('button');
  button.setAttribute('onclick', 'window.handlerExecuted = true'); document.body.append(button); button.click();
  const base = document.createElement('base'); base.href = 'https://invalid.example/'; document.head.append(base);
  const object = document.createElement('object'); object.data = '/__payload.html'; document.body.append(object);
});`;
// Exercise the actual web adapter with an isolated Turnstile stub. This is
// lifecycle/CSP coverage, not proof of a real challenge or server Siteverify.
const captchaSource = new URL('../apps/mobile/src/supabase/', import.meta.url);
const captchaConfig = stripTypeScriptTypes(await readFile(new URL('captcha.ts', captchaSource), 'utf8'))
  .replaceAll('process.env.EXPO_PUBLIC_TURNSTILE_ENABLED', 'undefined')
  .replaceAll('process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY', 'undefined');
const captchaAdapter = stripTypeScriptTypes(await readFile(new URL('run-captcha.web.ts', captchaSource), 'utf8'))
  .replace("from './captcha'", "from '/__captcha-config.js'") + '\nwindow.runCaptchaChallenge = runCaptchaChallenge;';
let captchaScriptMode = 'stub';
let captchaScriptRequests = 0;
const captchaStub = `window.turnstile = {
  render(container, options) {
    window.captchaWidget = {options, fragment: location.hash};
    if (window.captchaThrowOnRender) throw new Error('fixture render failure');
    container.textContent = 'Isolated verification fixture';
    return 'fixture-widget';
  },
  remove(id) { window.removedWidget = id; }
};`;
let remoteScriptRequests = 0;
const foreign = createServer((req, res) => {
  remoteScriptRequests += 1;
  res.writeHead(200, { 'Content-Type': 'text/javascript' });
  res.end('window.foreignExecuted = true');
});
await new Promise((r) => foreign.listen(0, '127.0.0.1', r));
const foreignOrigin = `http://127.0.0.1:${foreign.address().port}`;
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    let body;
    let type = 'text/html';
    if (pathname === '/__captcha-config.js') { body = captchaConfig; type = 'text/javascript'; }
    else if (pathname === '/__captcha-adapter.js') { body = captchaAdapter; type = 'text/javascript'; }
    else if (pathname === '/__captcha-web.html') { body = '<title>Keepory CAPTCHA fixture</title><button id="focus">Initial focus</button><script type="module" src="/__captcha-adapter.js"></script>'; }
    else if (pathname === '/__probe.js') { body = probe; type = 'text/javascript'; }
    else if (pathname === '/__attacks.html') {
      body = `<script src="/__probe.js"></script><script src="${foreignOrigin}/evil.js"></script><script src="data:text/javascript,window.dataExecuted=true"></script>`;
    } else if (pathname === '/__frame.html') { body = '<iframe src="/__attacks.html"></iframe>'; }
    else if (pathname === '/__payload.html') { body = '<script>parent.objectExecuted=true</script>'; }
    else {
      const file = resolve(exportRoot, '.' + decodeURIComponent(pathname));
      if (file !== exportRoot && !file.startsWith(exportRoot + sep)) { res.writeHead(403); res.end(); return; }
      try { body = await readFile(file); type = types[extname(file)] ?? 'application/octet-stream'; }
      catch { body = await readFile(join(exportRoot, 'index.html')); }
    }
    res.writeHead(200, { ...headers, 'Content-Type': type }); res.end(body);
  } catch { res.writeHead(500); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'keepory-web-security-'));
const chrome = spawn(process.argv[3] ?? '/usr/bin/google-chrome', [
  '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
  '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeError;
let chromeStderr = '';
chrome.on('error', (error) => { chromeError = error; });
chrome.stderr.on('data', (chunk) => { chromeStderr = (chromeStderr + chunk.toString()).slice(-4096); });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let socket;
let send;
try {
  let port;
  const startupDeadline = Date.now() + 30_000;
  while (Date.now() < startupDeadline) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch {
      if (chromeError || chrome.exitCode !== null) throw new Error(`Chrome exited before startup: ${chromeError?.message ?? chromeStderr}`);
      await delay(100);
    }
  }
  assert.ok(port, `Chrome must start within 30 seconds. Browser diagnostics: ${chromeStderr}`);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await Promise.race([once(socket, 'open'), delay(5000).then(() => { throw new Error('CDP connection timeout'); })]);
  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  const violations = [];
  send = (method, params = {}) => new Promise((resolveCommand, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
    pending.set(id, { resolve: resolveCommand, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const command = pending.get(message.id); if (!command) return;
      pending.delete(message.id); clearTimeout(command.timeout);
      if (message.error) command.reject(new Error(message.error.message)); else command.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
    else if (message.method === 'Log.entryAdded' && message.params.entry.source === 'security') { violations.push(message.params.entry.text); }
    else if (message.method === 'Fetch.requestPaused') {
      const { request, requestId } = message.params;
      if (request.url === 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit') {
        captchaScriptRequests += 1;
        void send(captchaScriptMode === 'stub' ? 'Fetch.fulfillRequest' : 'Fetch.failRequest', captchaScriptMode === 'stub'
          ? { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }], body: Buffer.from(captchaStub).toString('base64') }
          : { requestId, errorReason: 'Aborted' });
        return;
      }
      const allowed = [origin, foreignOrigin].includes(new URL(request.url).origin) && ['GET', 'HEAD'].includes(request.method);
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId } : { requestId, errorReason: 'Aborted' });
    }
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: 'http*', requestStage: 'Request' }] });
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true });
    assert.ok(!response.exceptionDetails, 'Browser evaluation must succeed'); return response.result.value;
  };
  const navigate = async (path) => {
    const result = await send('Page.navigate', { url: origin + path });
    assert.ok(!result.errorText, 'Navigation must succeed');
    await delay(2000);
  };
  for (const path of ['/', '/settings', '/privacy.html', '/account-deletion.html']) {
    await navigate(path);
    const needsHydration = path === '/' || path === '/settings';
    const deadline = Date.now() + 30_000;
    let state;
    // A fixed two-second snapshot can observe the loading shell on a busy CI
    // runner. Wait for the actual content/hydration conditions, retaining the
    // same assertions and a bounded failure with useful browser diagnostics.
    do {
      state = JSON.parse(await evaluate('JSON.stringify({path:location.pathname,title:document.title,text:document.body.innerText,buttons:document.querySelectorAll("button,[role=button]").length})'));
      if (state.path === path && /Keepory/.test(state.title) && state.text.trim().length > 40
        && (!needsHydration || state.buttons > 0)) break;
      if (exceptions.length || violations.length) break;
      await delay(100);
    } while (Date.now() < deadline);
    const diagnostics = JSON.stringify({state, exceptions, violations});
    assert.equal(state.path, path, `${path} must navigate: ${diagnostics}`);
    assert.match(state.title, /Keepory/);
    assert.ok(state.text.trim().length > 40, `${path} must render content within 30 seconds: ${diagnostics}`);
    if (needsHydration) assert.ok(state.buttons > 0, `${path} must hydrate within 30 seconds: ${diagnostics}`);
  }
  assert.deepEqual(exceptions, [], 'App pages must have no runtime exceptions');
  assert.deepEqual(violations, [], 'App pages must not violate CSP');
  const captchaViolationsBefore = violations.length;
  const captchaStorageBefore = await evaluate('JSON.stringify(Object.keys(localStorage).sort())');
  await navigate('/__captcha-web.html');
  const startChallenge = async () => {
    await evaluate(`window.captchaResult = undefined; window.captchaAbort = new AbortController();
      window.runCaptchaChallenge({signal:window.captchaAbort.signal}).then(
        token => window.captchaResult = {token}, error => window.captchaResult = {error:error.message});`);
    await delay(100);
  };
  const result = () => evaluate('window.captchaResult');
  await evaluate('document.getElementById("focus").focus()');
  await startChallenge();
  assert.equal(await evaluate('document.querySelector("dialog").open'), true);
  assert.equal(await evaluate('window.captchaWidget.options.sitekey'), '0x4AAAAAAFPASxaYl2wtIAFc');
  assert.equal(await evaluate('window.captchaWidget.options.action'), 'anonymous-signup');
  await evaluate('window.captchaWidget.options.callback("fixture-one-use")'); await delay(50);
  assert.deepEqual(await result(), {token: 'fixture-one-use'});
  assert.equal(await evaluate('document.querySelector("dialog")'), null);
  assert.equal(await evaluate('document.activeElement.id'), 'focus');
  assert.equal(await evaluate('window.removedWidget'), 'fixture-widget');
  for (const callback of ['error-callback', 'expired-callback', 'timeout-callback']) {
    await startChallenge();
    await evaluate(`window.captchaWidget.options[${JSON.stringify(callback)}]()`); await delay(50);
    assert.match((await result()).error, /verification failed/);
    assert.equal(await evaluate('document.querySelector("dialog")'), null);
  }
  await startChallenge();
  await evaluate('document.querySelector("dialog button").click()'); await delay(50);
  assert.match((await result()).error, /cancelled/);
  await startChallenge();
  await evaluate('window.captchaWidget.options.callback("bad token")'); await delay(50);
  assert.match((await result()).error, /verification failed/);
  await startChallenge();
  await evaluate('window.captchaAbort.abort(); window.captchaWidget.options.callback("late-token")'); await delay(50);
  assert.match((await result()).error, /cancelled/);
  assert.equal(await evaluate('document.querySelector("dialog")'), null);
  await evaluate('window.captchaThrowOnRender = true'); await startChallenge();
  assert.match((await result()).error, /verification failed/);
  assert.equal(await evaluate('document.querySelector("dialog")'), null);
  captchaScriptMode = 'failed';
  await navigate('/__captcha-web.html'); await startChallenge(); await delay(100);
  assert.match((await result()).error, /verification failed/);
  assert.equal(await evaluate('document.querySelector("dialog")'), null);
  captchaScriptMode = 'stub';
  const priorCaptchaRequests = captchaScriptRequests;
  await navigate('/captcha.html#state=invalid&sitekey=invalid');
  assert.equal(captchaScriptRequests, priorCaptchaRequests, 'Malformed native parameters must not load Turnstile');
  const nonce = 'a'.repeat(64);
  await navigate('/__captcha-web.html');
  await navigate('/captcha.html#' + new URLSearchParams({sitekey:'0x4AAAAAAFPASxaYl2wtIAFc', state:nonce}));
  assert.equal(await evaluate('location.hash'), '', 'Nonce must be removed before provider loading');
  assert.equal(await evaluate('window.captchaWidget.fragment'), '');
  assert.equal(await evaluate('window.captchaWidget.options.action'), 'anonymous-signup');
  await evaluate('window.captchaWidget.options.callback("invalid token")');
  assert.match(await evaluate('document.getElementById("status").textContent'), /could not complete/);
  assert.equal(await evaluate('JSON.stringify(Object.keys(localStorage).sort())'), captchaStorageBefore, 'CAPTCHA must not add persistent keys');
  assert.deepEqual(exceptions, [], 'CAPTCHA fixtures must have no unhandled exceptions');
  assert.equal(violations.length, captchaViolationsBefore, 'CAPTCHA adapter and hosted page must satisfy CSP');
  await navigate('/__attacks.html');
  const attack = JSON.parse(await evaluate('JSON.stringify({probe:window.probe,inline:!!window.inlineExecuted,handler:!!window.handlerExecuted,foreign:!!window.foreignExecuted,data:!!window.dataExecuted,eval:!!window.evalExecuted,func:!!window.functionExecuted,object:!!window.objectExecuted,base:document.baseURI})'));
  assert.equal(attack.probe.self, true, 'Same-origin JavaScript must run');
  assert.equal(attack.probe.wasm, true, 'Markdown WebAssembly must remain available');
  assert.equal(attack.probe.evalBlocked, true); assert.equal(attack.probe.functionBlocked, true);
  for (const key of ['inline', 'handler', 'foreign', 'data', 'eval', 'func', 'object']) assert.equal(attack[key], false, `${key} attack must not run`);
  assert.equal(attack.base, origin + '/__attacks.html');
  assert.equal(remoteScriptRequests, 0, 'Foreign script must be blocked before a request');
  for (const directive of ['script-src-elem', 'script-src-attr', 'base-uri', 'object-src']) assert.ok(attack.probe.violations.includes(directive), `${directive} must be enforced`);
  await navigate('/__frame.html');
  assert.ok(violations.some((message) => message.includes('frame-ancestors')), 'Iframe embedding must be rejected');
  assert.equal(await evaluate('(() => { try { return !!document.querySelector("iframe").contentWindow.probe; } catch { return false; } })()'), false, 'Framed content must not execute');
  console.log(JSON.stringify({ status: 'pass', pages: 4, blockedAttacks: ['inline', 'event-handler', 'foreign-script', 'data-script', 'eval', 'new-function', 'base', 'object', 'iframe'], sameOriginScript: true, webAssembly: true, captcha: 'isolated adapter and hosted-page lifecycle passed; real Siteverify pending' }));
} finally {
  try {
    if (socket && socket.readyState === 1 /* WebSocket.OPEN */) {
      await Promise.race([send?.('Browser.close'), delay(1000)]).catch(() => {});
    }
  } catch {}
  socket?.close();
  if (!chromeError && chrome.exitCode === null) {
    const ended = once(chrome, 'exit'); chrome.kill('SIGTERM');
    await Promise.race([ended, delay(2000)]);
    if (!chromeError && chrome.exitCode === null) {
      chrome.kill('SIGKILL');
      await Promise.race([ended, delay(1000)]);
    }
  }
  await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => foreign.close(r))]);
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(async () => {
    await delay(500);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((error) => {
      console.warn('Chrome temporary-profile cleanup failed after retries:', error?.code ?? 'unknown');
    });
  });
}
