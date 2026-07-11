interface ParsedSemver {
  main: [number, number, number];
  prerelease: string[];
}

function parseSemver(value: string): ParsedSemver {
  const normalized = value.trim().replace(/^v/, '');
  const [mainPart, prereleasePart] = normalized.split('-', 2);
  const main = mainPart.split('.').map((part) => Number.parseInt(part, 10));
  return {
    main: [
      Number.isFinite(main[0]) ? main[0] : 0,
      Number.isFinite(main[1]) ? main[1] : 0,
      Number.isFinite(main[2]) ? main[2] : 0,
    ],
    prerelease: prereleasePart ? prereleasePart.split('.') : [],
  };
}

function splitIdentifier(value: string): Array<string | number> {
  const chunks = value.match(/\d+|\D+/g) ?? [value];
  return chunks.map((chunk) => (/^\d+$/.test(chunk) ? Number.parseInt(chunk, 10) : chunk));
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aParts = splitIdentifier(a);
  const bParts = splitIdentifier(b);
  const length = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < length; index += 1) {
    const left = aParts[index];
    const right = bParts[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    if (typeof left === 'number') return -1;
    if (typeof right === 'number') return 1;
    return left.localeCompare(right);
  }

  return 0;
}

/** Compare semver-ish app versions. Returns negative if a < b, 0 if equal, positive if a > b. */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);

  for (let index = 0; index < 3; index += 1) {
    const diff = left.main[index] - right.main[index];
    if (diff !== 0) return diff;
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = left.prerelease[index];
    const rightId = right.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const diff = comparePrereleaseIdentifier(leftId, rightId);
    if (diff !== 0) return diff;
  }

  return 0;
}
