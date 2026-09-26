/**
 * Generates a v4-shaped UUID string. Prefers `crypto.randomUUID()` when
 * available (modern browsers, Hermes with crypto support, or the Node test
 * runner) and otherwise falls back to a Math.random-based v4 — these are
 * dedupe/identity keys, not secrets, so they only need to be unique, not
 * cryptographically strong.
 */
export function makeUuid(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = (Math.random() * 16) | 0;
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}
