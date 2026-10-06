import { CAPTCHA_CANCELLED_MESSAGE, CAPTCHA_FAILED_MESSAGE, CAPTCHA_TIMEOUT_MS, getCaptchaSiteKey, isCaptchaToken } from './captcha';

interface Turnstile {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
}
type CaptchaWindow = Window & { turnstile?: Turnstile };
let loading: Promise<Turnstile> | undefined;
let running = false;

function loadTurnstile(): Promise<Turnstile> {
  const existing = (window as CaptchaWindow).turnstile;
  if (existing) return Promise.resolve(existing);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const failed = () => { clearTimeout(timer); script.remove(); loading = undefined; reject(new Error(CAPTCHA_FAILED_MESSAGE)); };
    const timer = setTimeout(failed, 15_000);
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    script.onerror = failed;
    script.onload = () => {
      clearTimeout(timer);
      const api = (window as CaptchaWindow).turnstile;
      if (api) resolve(api); else failed();
    };
    document.head.append(script);
  });
  return loading;
}

export async function runCaptchaChallenge(options: { signal?: AbortSignal } = {}): Promise<string | undefined> {
  const siteKey = getCaptchaSiteKey();
  if (!siteKey) return undefined;
  if (options.signal?.aborted) throw new Error(CAPTCHA_CANCELLED_MESSAGE);
  if (running || typeof document === 'undefined') throw new Error(CAPTCHA_FAILED_MESSAGE);
  running = true;
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  const title = document.createElement('h2');
  const explanation = document.createElement('p');
  const container = document.createElement('div');
  const cancel = document.createElement('button');
  const korean = navigator.language.startsWith('ko');
  title.textContent = korean ? '클라우드 동기화 확인' : 'Verify cloud sync';
  explanation.textContent = korean ? '저장한 항목은 기기에 보관됩니다. 클라우드 동기화를 위해 아래 확인을 완료해 주세요.' : 'Your saved items remain on this device. Complete the check below to start cloud sync.';
  cancel.textContent = korean ? '취소' : 'Cancel';
  cancel.type = 'button';
  title.id = 'keepory-captcha-title';
  dialog.setAttribute('aria-labelledby', title.id);
  Object.assign(dialog.style, { maxWidth: '380px', width: 'calc(100% - 48px)', borderRadius: '16px', padding: '24px', border: '1px solid #888', fontFamily: 'system-ui' });
  dialog.append(title, explanation, container, cancel);
  document.body.append(dialog);
  let widget: string | undefined;
  let api: Turnstile | undefined;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (token?: unknown, error?: string) => {
        if (!active) return;
        active = false;
        if (error || !isCaptchaToken(token)) reject(new Error(error ?? CAPTCHA_FAILED_MESSAGE)); else resolve(token);
      };
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(undefined, CAPTCHA_CANCELLED_MESSAGE); });
      cancel.addEventListener('click', () => finish(undefined, CAPTCHA_CANCELLED_MESSAGE));
      onAbort = () => finish(undefined, CAPTCHA_CANCELLED_MESSAGE);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(undefined, CAPTCHA_FAILED_MESSAGE), CAPTCHA_TIMEOUT_MS);
      try { dialog.showModal(); } catch { finish(undefined, CAPTCHA_FAILED_MESSAGE); return; }
      void loadTurnstile().then((loaded) => {
        if (!active) return;
        api = loaded;
        widget = loaded.render(container, {
          sitekey: siteKey, action: 'anonymous-signup', language: korean ? 'ko' : 'en', retry: 'never',
          callback: (token: string) => finish(token),
          'error-callback': () => { finish(undefined, CAPTCHA_FAILED_MESSAGE); return true; },
          'expired-callback': () => finish(undefined, CAPTCHA_FAILED_MESSAGE),
          'timeout-callback': () => finish(undefined, CAPTCHA_FAILED_MESSAGE),
        });
      }).catch(() => finish(undefined, CAPTCHA_FAILED_MESSAGE));
    });
  } finally {
    active = false; clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
    if (widget && api) { try { api.remove(widget); } catch { /* Still remove the dialog. */ } }
    dialog.remove(); running = false;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  }
}
