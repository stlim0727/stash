export function shouldShowWordmarkFallback(input: {
  platform: string;
  wordmarkFailed: boolean;
  wordmarkLoaded: boolean;
}) {
  return input.wordmarkFailed || (input.platform === 'web' && !input.wordmarkLoaded);
}
