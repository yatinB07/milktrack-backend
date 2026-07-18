import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError } from '../src/common/errors/application.error.js';
import { requireVendorTransition } from '../src/vendors/domain/vendor-lifecycle.js';

const isCode = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;

void test('vendor lifecycle allows only the reviewed transition table', () => {
  const allowed = [
    ['pending_approval', 'onboarding'],
    ['onboarding', 'trial'],
    ['onboarding', 'active'],
    ['trial', 'active'],
    ['trial', 'suspended'],
    ['active', 'suspended'],
    ['active', 'closed'],
    ['suspended', 'active'],
    ['suspended', 'closed'],
  ] as const;

  for (const [from, to] of allowed) {
    assert.doesNotThrow(() => requireVendorTransition(from, to));
  }
  assert.throws(
    () => requireVendorTransition('closed', 'active'),
    isCode('VENDOR_STATE_CONFLICT'),
  );
  assert.throws(
    () => requireVendorTransition('active', 'active'),
    isCode('VENDOR_STATE_CONFLICT'),
  );
});
