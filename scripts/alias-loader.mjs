/**
 * Module resolve hook so Node can run the mobile app's TypeScript directly:
 * maps the Metro alias `@/x` to apps/mobile/src/x(.ts|.tsx).
 * Used by scripts/verify-supabase.mjs together with --experimental-strip-types.
 */
const SRC = new URL('../apps/mobile/src/', import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const base = specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      try {
        return await nextResolve(new URL(base + suffix, SRC).href, context);
      } catch {
        // try the next extension
      }
    }
    return nextResolve(new URL(base, SRC).href, context);
  }
  return nextResolve(specifier, context);
}
