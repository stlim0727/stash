// Decode HTML bytes for any charset. Hermes' built-in TextDecoder is UTF-8
// only, so we register the WHATWG encoding tables (euc-kr, shift_jis, gbk,
// big5, …) and use @zxing/text-encoding's decoder. Many Korean/Japanese/
// Chinese sites still serve legacy-encoded HTML, which decoded as UTF-8 turns
// into mojibake.
//
// This module is loaded lazily (dynamic import) from the metadata fetcher so
// the large encoding tables stay out of the pure import graph.

import '@zxing/text-encoding/cjs/encoding-indexes.js';
import { TextDecoder as LegacyTextDecoder } from '@zxing/text-encoding/cjs/encoding.js';

export function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new LegacyTextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    // Unknown label — fall back to UTF-8 rather than throwing.
    return new LegacyTextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}
