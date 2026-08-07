export function shouldShowWordmarkFallback(input: {
  platform: string;
  wordmarkFailed: boolean;
  wordmarkLoaded: boolean;
}) {
  return input.wordmarkFailed || (input.platform === 'web' && !input.wordmarkLoaded);
}

// On web, some resource fetches abort mid-download under memory/CPU pressure
// (seen alongside a heavy sync pull + main-thread stall in STASH-5J) yet the
// <img> element still fires `load` instead of `error`, leaving a 0x0 image.
// Treat that as a failed load — a `wordmarkLoaded: true` with no pixels is a
// permanently blank hero, since `shouldShowWordmarkFallback` never revisits a
// load that already reported success.
export function didWordmarkImageLoad(source: { width: number; height: number } | undefined) {
  return !!source && source.width > 0 && source.height > 0;
}
