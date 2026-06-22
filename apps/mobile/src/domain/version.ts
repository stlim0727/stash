/** Compare two semver strings. Returns negative if a < b, 0 if equal, positive if a > b. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [aMaj = 0, aMin = 0, aPat = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPat = 0] = parse(b);
  return aMaj !== bMaj ? aMaj - bMaj : aMin !== bMin ? aMin - bMin : aPat - bPat;
}
