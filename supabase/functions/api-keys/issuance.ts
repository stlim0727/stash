// Whether the api-keys issuer may mint new keys.
//
// Fail-closed: issuance is enabled ONLY when the flag is exactly the string
// "true". Any other value — unset, empty, "1", "TRUE", "yes", a typo — keeps
// issuance OFF. This is deliberate: the public-API surface ships "built but not
// exposed" (docs/api/public-api.md), so the default and every misconfiguration
// must land on denied, never on accidentally-open.
export function isIssuanceEnabled(flag: string | undefined | null): boolean {
  return flag === 'true';
}
