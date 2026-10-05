// Named import keeps manual redirect control even when EXPO_PUBLIC_USE_RN_FETCH
// changes the global transport back to the XHR-based React Native polyfill.
import { fetch } from 'expo/fetch';

export function previewFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}
