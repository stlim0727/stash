declare module '@zxing/text-encoding/cjs/encoding.js' {
  export class TextDecoder {
    constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
    decode(input?: ArrayBuffer | ArrayBufferView): string;
  }
  export class TextEncoder {
    encode(input?: string): Uint8Array;
  }
}

declare module '@zxing/text-encoding/cjs/encoding-indexes.js';
