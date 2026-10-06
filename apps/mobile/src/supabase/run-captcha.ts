// Native flow uses the existing system auth browser, not an embedded dependency.
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { buildCaptchaChallengeUrl, CAPTCHA_CALLBACK_URL, CAPTCHA_CANCELLED_MESSAGE, CAPTCHA_FAILED_MESSAGE, CAPTCHA_TIMEOUT_MS, getCaptchaSiteKey, parseCaptchaCallback } from './captcha';

let running = false;

export async function runCaptchaChallenge(options: { signal?: AbortSignal } = {}): Promise<string | undefined> {
  const siteKey = getCaptchaSiteKey();
  if (!siteKey) return undefined;
  if (options.signal?.aborted) throw new Error(CAPTCHA_CANCELLED_MESSAGE);
  if (running) throw new Error(CAPTCHA_FAILED_MESSAGE);
  running = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const state = Array.from(Crypto.getRandomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const result = await Promise.race([
      WebBrowser.openAuthSessionAsync(buildCaptchaChallengeUrl(siteKey, state), CAPTCHA_CALLBACK_URL),
      new Promise<never>((_, reject) => {
        onAbort = () => {
          try { WebBrowser.dismissAuthSession(); } catch { /* Browser may already be dismissed. */ }
          reject(new Error(CAPTCHA_CANCELLED_MESSAGE));
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          try { WebBrowser.dismissAuthSession(); } catch { /* Browser may already be dismissed. */ }
          reject(new Error(CAPTCHA_FAILED_MESSAGE));
        }, CAPTCHA_TIMEOUT_MS);
      }),
    ]);
    if (result.type !== 'success' || !result.url || result.url === CAPTCHA_CALLBACK_URL) throw new Error(CAPTCHA_CANCELLED_MESSAGE);
    return parseCaptchaCallback(result.url, state);
  } finally {
    clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
    running = false;
  }
}
