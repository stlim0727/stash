// No @types/react-dom in this project (react-dom is only reached indirectly,
// via react-native-web); this covers the one export `ui/sync-flush.ts` needs.
declare module 'react-dom' {
  export function flushSync<R>(fn: () => R): R;
}
