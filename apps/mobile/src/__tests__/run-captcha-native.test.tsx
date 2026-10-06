jest.mock('expo-crypto', () => ({ getRandomBytes: jest.fn(() => new Uint8Array(32).fill(1)) }));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(), dismissAuthSession: jest.fn() }));
import { getRandomBytes } from 'expo-crypto';
import { openAuthSessionAsync, dismissAuthSession } from 'expo-web-browser';
import { runCaptchaChallenge } from '@/supabase/run-captcha';
import { CAPTCHA_CALLBACK_URL, CAPTCHA_TIMEOUT_MS } from '@/supabase/captcha';

const state = '01'.repeat(32);
const enabled = process.env.EXPO_PUBLIC_TURNSTILE_ENABLED;
const key = process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_TURNSTILE_ENABLED = 'true';
  process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
});
afterEach(() => {
  jest.useRealTimers();
  if (enabled === undefined) delete process.env.EXPO_PUBLIC_TURNSTILE_ENABLED; else process.env.EXPO_PUBLIC_TURNSTILE_ENABLED = enabled;
  if (key === undefined) delete process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY; else process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = key;
});

test('disabled CAPTCHA never opens a browser', async () => {
  process.env.EXPO_PUBLIC_TURNSTILE_ENABLED = 'false';
  expect(await runCaptchaChallenge()).toBeUndefined();
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
});

test('native browser token must match the nonce and callback; no token is cached', async () => {
  (openAuthSessionAsync as jest.Mock).mockResolvedValue({ type: 'success', url: `${CAPTCHA_CALLBACK_URL}#state=${state}&token=one-use` });
  expect(await runCaptchaChallenge()).toBe('one-use');
  expect(openAuthSessionAsync).toHaveBeenCalledWith(expect.stringContaining('https://keepory.app/captcha.html#'), CAPTCHA_CALLBACK_URL);
  await runCaptchaChallenge();
  expect(openAuthSessionAsync).toHaveBeenCalledTimes(2);
  expect(getRandomBytes).toHaveBeenCalledTimes(2);
});

test('cancel and forged callbacks reject without a token', async () => {
  for (const result of [{ type: 'cancel' }, { type: 'success', url: CAPTCHA_CALLBACK_URL }, { type: 'success', url: `${CAPTCHA_CALLBACK_URL}#state=${'02'.repeat(32)}&token=one-use` }]) {
    (openAuthSessionAsync as jest.Mock).mockResolvedValueOnce(result);
    await expect(runCaptchaChallenge()).rejects.toThrow(/verification/i);
  }
});

test('concurrent challenge is rejected and timeout dismisses the browser', async () => {
  jest.useFakeTimers();
  (openAuthSessionAsync as jest.Mock).mockImplementation(() => new Promise(() => {}));
  const pending = runCaptchaChallenge();
  const rejected = expect(pending).rejects.toThrow(/verification/i);
  await expect(runCaptchaChallenge()).rejects.toThrow(/verification/i);
  jest.advanceTimersByTime(CAPTCHA_TIMEOUT_MS);
  await rejected;
  expect(dismissAuthSession).toHaveBeenCalledTimes(1);
  expect(openAuthSessionAsync).toHaveBeenCalledTimes(1);
});

test('a random-source failure releases the in-flight guard', async () => {
  (getRandomBytes as jest.Mock).mockImplementationOnce(() => { throw new Error('crypto unavailable'); });
  await expect(runCaptchaChallenge()).rejects.toThrow('crypto unavailable');
  (openAuthSessionAsync as jest.Mock).mockResolvedValueOnce({ type: 'cancel' });
  await expect(runCaptchaChallenge()).rejects.toThrow(/cancelled/);
});


test('abort dismisses the native challenge and ignores a late valid callback', async () => {
  let complete!: (result: unknown) => void;
  (openAuthSessionAsync as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const controller = new AbortController();
  const pending = runCaptchaChallenge({ signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow(/cancelled/);
  controller.abort();
  await rejected;
  expect(dismissAuthSession).toHaveBeenCalledTimes(1);
  complete({ type: 'success', url: `${CAPTCHA_CALLBACK_URL}#state=${state}&token=late-token` });
  (openAuthSessionAsync as jest.Mock).mockResolvedValueOnce({ type: 'cancel' });
  await expect(runCaptchaChallenge()).rejects.toThrow(/cancelled/);
});

test('an already-aborted challenge never opens the browser', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(runCaptchaChallenge({ signal: controller.signal })).rejects.toThrow(/cancelled/);
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
});
