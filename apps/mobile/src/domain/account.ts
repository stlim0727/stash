/**
 * Derive up to two display initials for the account avatar from the user's
 * email. Falls back to a neutral dot when there is nothing usable (e.g. an
 * authenticated user whose email is hidden).
 */
export function accountInitials(email: string | null | undefined): string {
  const local = (email ?? '').split('@')[0] ?? '';
  const tokens = local.split(/[^a-zA-Z0-9]+/).filter(Boolean);

  if (tokens.length >= 2) {
    return (tokens[0]![0]! + tokens[1]![0]!).toUpperCase();
  }
  if (tokens.length === 1) {
    return tokens[0]!.slice(0, 2).toUpperCase();
  }
  return '•';
}
