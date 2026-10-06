// Public dashboard-created Keepory widget; no secret belongs in this module.
export const KEEPORY_TURNSTILE_SITE_KEY = '0x4AAAAAAFPASxaYl2wtIAFc';
export const CAPTCHA_CALLBACK_URL = 'stash://captcha/callback';
export const CAPTCHA_TIMEOUT_MS = 180_000;
export const CAPTCHA_MAX_TOKEN_LENGTH = 2048;
export const CAPTCHA_CANCELLED_MESSAGE = 'Cloud sync verification was cancelled. Saved items remain on this device.';
export const CAPTCHA_FAILED_MESSAGE = 'Cloud sync verification failed. Saved items remain on this device. Try Sync now again.';

export function getCaptchaSiteKey(): string | undefined {
  if (process.env.EXPO_PUBLIC_TURNSTILE_ENABLED === 'false') return undefined;
  const key = (process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY ?? KEEPORY_TURNSTILE_SITE_KEY).trim();
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(key)) throw new Error(CAPTCHA_FAILED_MESSAGE);
  return key;
}

export function isCaptchaToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= CAPTCHA_MAX_TOKEN_LENGTH && !/\s/.test(value);
}

export function buildCaptchaChallengeUrl(siteKey: string, state: string): string {
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(siteKey) || !/^[a-f0-9]{64}$/.test(state)) throw new Error(CAPTCHA_FAILED_MESSAGE);
  const url = new URL('https://keepory.app/captcha.html');
  // Keep the nonce in the fragment so the hosting/CDN request log never receives it.
  url.hash = new URLSearchParams({ sitekey: siteKey, state }).toString();
  return url.toString();
}

export function parseCaptchaCallback(value: string, expectedState: string): string {
  try {
    const url = new URL(value);
    const callback = new URL(CAPTCHA_CALLBACK_URL);
    if (url.protocol !== callback.protocol || url.host !== callback.host || url.pathname !== callback.pathname || url.search || url.username || url.password) throw new Error();
    const params = new URLSearchParams(url.hash.slice(1));
    if (params.getAll('state').length !== 1 || params.getAll('token').length !== 1 || params.get('state') !== expectedState || !/^[a-f0-9]{64}$/.test(expectedState)) throw new Error();
    const token = params.get('token');
    if (!isCaptchaToken(token)) throw new Error();
    return token;
  } catch { throw new Error(CAPTCHA_FAILED_MESSAGE); }
}
