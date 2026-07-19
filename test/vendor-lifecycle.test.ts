import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError } from '../src/common/errors/application.error.js';
import * as vendorLifecycle from '../src/vendors/domain/vendor-lifecycle.js';

const { requireVendorTransition, allowedVendorTransitions } = vendorLifecycle;

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

void test('vendor lifecycle projects defensive copies of allowed transitions', () => {
  const expected = {
    pending_approval: ['onboarding'],
    onboarding: ['trial', 'active'],
    trial: ['active', 'suspended'],
    active: ['suspended', 'closed'],
    suspended: ['active', 'closed'],
    closed: [],
  } as const satisfies Readonly<Record<vendorLifecycle.VendorStatus, readonly vendorLifecycle.VendorStatus[]>>;

  for (const [status, targets] of Object.entries(expected) as Array<
    [vendorLifecycle.VendorStatus, readonly vendorLifecycle.VendorStatus[]]
  >) {
    const first = allowedVendorTransitions(status);
    assert.deepEqual(first, targets);
    assert.notStrictEqual(first, allowedVendorTransitions(status));
    (first as vendorLifecycle.VendorStatus[]).push('closed');
    assert.deepEqual(allowedVendorTransitions(status), targets);
  }
});
