// The site key is public; the one-use challenge token is never stored or logged.
(() => {
  const korean = navigator.language.startsWith('ko');
  const status = document.getElementById('status');
  if (korean) {
    document.documentElement.lang = 'ko';
    document.getElementById('title').textContent = '클라우드 동기화 확인';
    document.getElementById('description').textContent = '저장한 항목은 기기에 보관됩니다. 클라우드 동기화를 위해 아래 확인을 완료해 주세요.';
    document.getElementById('return').textContent = 'Keepory로 돌아가기';
    status.textContent = '확인 화면을 불러오는 중…';
  }
  const params = new URLSearchParams(location.hash.slice(1));
  // Remove the nonce from browser history before any external script loads.
  history.replaceState(null, '', location.pathname);
  const sitekey = params.get('sitekey');
  const state = params.get('state');
  let active = true;
  let widget;
  let timeout;
  const cancel = () => { active = false; clearTimeout(timeout); location.replace('stash://captcha/callback'); };
  document.getElementById('return').addEventListener('click', cancel);
  const failed = () => {
    if (!active) return;
    active = false;
    clearTimeout(timeout);
    status.textContent = korean ? '확인을 완료하지 못했습니다. 기기 저장은 유지됩니다. 앱으로 돌아가 동기화를 다시 시도해 주세요.' : 'Verification could not complete. Saved items remain on this device. Return to the app and try Sync now again.';
    if (widget && window.turnstile) window.turnstile.remove(widget);
  };
  if (params.getAll('sitekey').length !== 1 || params.getAll('state').length !== 1 || !/^[A-Za-z0-9_-]{10,100}$/.test(sitekey ?? '') || !/^[a-f0-9]{64}$/.test(state ?? '')) { failed(); return; }
  timeout = setTimeout(failed, 180_000);
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.referrerPolicy = 'no-referrer';
  script.onerror = failed;
  script.onload = () => {
    if (!active) return;
    try {
      widget = window.turnstile.render(document.getElementById('challenge'), {
        sitekey, action: 'anonymous-signup', language: korean ? 'ko' : 'en', retry: 'never',
        callback: (token) => {
          if (!active) return;
          if (typeof token !== 'string' || !token || token.length > 2048 || /\s/.test(token)) { failed(); return; }
          active = false; clearTimeout(timeout);
          location.replace('stash://captcha/callback#' + new URLSearchParams({ state, token }).toString());
        },
        'error-callback': () => { failed(); return true; },
        'expired-callback': failed, 'timeout-callback': failed,
      });
      status.textContent = korean ? '아래 확인을 완료해 주세요.' : 'Complete the check below.';
    } catch { failed(); }
  };
  document.head.append(script);
})();
