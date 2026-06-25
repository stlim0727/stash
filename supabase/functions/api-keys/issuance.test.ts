import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isIssuanceEnabled } from './issuance.ts';

test('isIssuanceEnabled: only the exact string "true" enables issuance', () => {
  assert.equal(isIssuanceEnabled('true'), true);
});

test('isIssuanceEnabled: fail-closed for unset / empty / typo values', () => {
  // The security-relevant invariant: every value other than exactly "true"
  // keeps issuance denied, so a missing or fat-fingered env cannot open the
  // door the v0.2.2 posture is meant to keep shut.
  for (const flag of [undefined, null, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
    assert.equal(isIssuanceEnabled(flag), false, `expected disabled for ${JSON.stringify(flag)}`);
  }
});
