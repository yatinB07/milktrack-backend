import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { OwnerEnrollmentDelivery } from '../src/memberships/application/owner-enrollment.delivery.js';
import {
  DefaultVendorOwnerOnboardingService,
  type OwnerOnboardingUnitOfWork,
  VendorOwnerOnboardingStore,
} from '../src/memberships/application/vendor-owner-onboarding.service.js';

void test('a transient delivery failure retries the persisted enrollment without orphaning it', async () => {
  const vendorId = randomUUID();
  const actor: Actor = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    displayName: 'Platform Administrator',
    authenticationMethod: 'administrator_mfa',
    platformRoles: ['platform_administrator'],
    memberships: [],
  };
  let enrollmentCount = 0;
  let deliveryCalls = 0;
  let deliveryState: string | undefined;
  const unit: OwnerOnboardingUnitOfWork = {
    lockVendor: () => Promise.resolve('onboarding'),
    countEffectiveOwners: () => Promise.resolve(0),
    retireExpiredEnrollment: () => Promise.resolve(),
    findUserByEmail: () => Promise.resolve(null),
    createUser: () => Promise.resolve(),
    createOwnerMembership: () => Promise.resolve(),
    createEnrollment: () => {
      enrollmentCount += 1;
      return Promise.resolve();
    },
    appendAudit: () => Promise.resolve(),
  };
  const store: VendorOwnerOnboardingStore = {
    status: () => Promise.resolve(null),
    run: async (_vendorId, operation) => operation(unit),
    markDelivery: (_vendorId, _enrollmentId, state) => {
      deliveryState = state;
      return Promise.resolve();
    },
    rotateDelivery: () => Promise.reject(new Error('not used')),
  };
  const delivery: OwnerEnrollmentDelivery = {
    send: () => {
      deliveryCalls += 1;
      return deliveryCalls === 1
        ? Promise.reject(new Error('temporary provider failure'))
        : Promise.resolve();
    },
  };
  const service = new DefaultVendorOwnerOnboardingService(store, delivery, {
    authHmacKey: Buffer.from('0123456789abcdef0123456789abcdef'),
  });

  const result = await requestContextStore.run(
    { correlationId: randomUUID(), actor },
    () => service.establish(actor, {
      vendorId,
      email: 'retry-owner@example.com',
      displayName: 'Retry Owner',
      reason: 'Verify recoverable delivery',
    }),
  );

  assert.equal(result.vendorId, vendorId);
  assert.equal(enrollmentCount, 1);
  assert.equal(deliveryCalls, 2);
  assert.equal(deliveryState, 'delivered');
});

void test('persistent delivery failure is reported and remains recoverable through token rotation', async () => {
  const vendorId = randomUUID();
  const actor: Actor = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    displayName: 'Platform Administrator',
    authenticationMethod: 'administrator_mfa',
    platformRoles: ['platform_administrator'],
    memberships: [],
  };
  let enrollmentId = '';
  let membershipId = '';
  let failDelivery = true;
  let deliveryState = '';
  const deliveredTokens: string[] = [];
  const unit: OwnerOnboardingUnitOfWork = {
    lockVendor: () => Promise.resolve('onboarding'),
    countEffectiveOwners: () => Promise.resolve(0),
    retireExpiredEnrollment: () => Promise.resolve(),
    findUserByEmail: () => Promise.resolve(null),
    createUser: () => Promise.resolve(),
    createOwnerMembership: (input) => {
      membershipId = input.id;
      return Promise.resolve();
    },
    createEnrollment: (input) => {
      enrollmentId = input.id;
      return Promise.resolve();
    },
    appendAudit: () => Promise.resolve(),
  };
  const store: VendorOwnerOnboardingStore = {
    status: () => Promise.resolve(null),
    run: async (_vendorId, operation) => operation(unit),
    markDelivery: (_vendorId, _enrollmentId, state) => {
      deliveryState = state;
      return Promise.resolve();
    },
    rotateDelivery: (input) => Promise.resolve({
      email: 'failed-owner@example.com',
      membershipId,
      expiresAt: input.expiresAt,
    }),
  };
  const delivery: OwnerEnrollmentDelivery = {
    send: (_destination, token) => {
      deliveredTokens.push(token);
      return failDelivery
        ? Promise.reject(new Error('persistent provider failure'))
        : Promise.resolve();
    },
  };
  const service = new DefaultVendorOwnerOnboardingService(store, delivery, {
    authHmacKey: Buffer.from('0123456789abcdef0123456789abcdef'),
  });
  const run = <T>(operation: () => Promise<T>) => requestContextStore.run(
    { correlationId: randomUUID(), actor },
    operation,
  );

  await assert.rejects(
    run(() => service.establish(actor, {
      vendorId,
      email: 'failed-owner@example.com',
      displayName: 'Failed Owner',
      reason: 'Persistent delivery regression',
    })),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'OWNER_ENROLLMENT_DELIVERY_PENDING' &&
      'status' in error && error.status === 503 &&
      'retryable' in error && error.retryable === true,
  );
  assert.equal(deliveryState, 'failed');
  const oldToken = deliveredTokens[0];
  assert.ok(oldToken);

  await assert.rejects(
    run(() => service.retry(actor, {
      vendorId,
      enrollmentId,
      reason: 'First retry also fails',
    })),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'OWNER_ENROLLMENT_DELIVERY_PENDING' &&
      'status' in error && error.status === 503 &&
      'retryable' in error && error.retryable === true,
  );
  assert.equal(deliveryState, 'failed');
  const failedRetryToken = deliveredTokens.at(-1);
  assert.ok(failedRetryToken);
  assert.notEqual(failedRetryToken, oldToken);

  failDelivery = false;
  const retried = await run(() => service.retry(actor, {
    vendorId,
    enrollmentId,
    reason: 'Rotate and retry failed delivery',
  }));
  assert.equal(retried.deliveryStatus, 'delivered');
  assert.equal(deliveryState, 'delivered');
  assert.notEqual(deliveredTokens.at(-1), failedRetryToken);
});

void test('projects the newest initial-owner enrollment state with safe role-specific fields', async () => {
  const vendorId = randomUUID();
  const administrator: Actor = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    displayName: 'Platform Administrator',
    authenticationMethod: 'administrator_mfa',
    platformRoles: ['platform_administrator'],
    memberships: [],
  };
  const productOwner: Actor = {
    ...administrator,
    userId: randomUUID(),
    platformRoles: ['product_owner'],
  };
  const past = new Date(Date.now() - 60 * 60_000);
  const future = new Date(Date.now() + 60 * 60_000);
  const enrollment = {
    enrollmentId: randomUUID(),
    membershipId: randomUUID(),
    ownerDisplayName: 'Initial Owner',
    ownerEmail: 'owner@example.com',
    expiresAt: future,
    startedAt: null as Date | null,
    consumedAt: null as Date | null,
    retiredAt: null as Date | null,
    deliveryState: 'delivered',
  };
  let current: typeof enrollment | null = null;
  const store = {
    status: () => Promise.resolve(current),
  } as unknown as VendorOwnerOnboardingStore;
  const service = new DefaultVendorOwnerOnboardingService(store, {
    send: () => Promise.resolve(),
  }, { authHmacKey: Buffer.from('0123456789abcdef0123456789abcdef') });

  assert.deepEqual(await service.status(administrator, vendorId), {
    vendorId,
    state: 'not_started',
  });

  const cases = [
    [{ consumedAt: past, retiredAt: past, startedAt: past, deliveryState: 'failed' }, 'completed'],
    [{ retiredAt: past, startedAt: past, deliveryState: 'failed' }, 'retired'],
    [{ expiresAt: past, startedAt: past, deliveryState: 'failed' }, 'expired'],
    [{ startedAt: past, deliveryState: 'failed' }, 'setup_started'],
    [{ deliveryState: 'failed' }, 'delivery_failed'],
    [{}, 'invited'],
  ] as const;
  for (const [overrides, state] of cases) {
    current = { ...enrollment, ...overrides };
    assert.deepEqual(await service.status(administrator, vendorId), {
      vendorId,
      state,
      enrollmentId: enrollment.enrollmentId,
      membershipId: enrollment.membershipId,
      ownerDisplayName: enrollment.ownerDisplayName,
      ownerEmail: enrollment.ownerEmail,
      expiresAt: current.expiresAt,
    });
  }
  assert.deepEqual(await service.status(productOwner, vendorId), {
    vendorId,
    state: 'invited',
    enrollmentId: enrollment.enrollmentId,
    membershipId: enrollment.membershipId,
    ownerDisplayName: enrollment.ownerDisplayName,
    expiresAt: enrollment.expiresAt,
  });
});

void test('requires administrator MFA and platform vendor read permission for onboarding status', async () => {
  const actor: Actor = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    displayName: 'Untrusted User',
    authenticationMethod: 'phone_otp',
    platformRoles: ['product_owner'],
    memberships: [],
  };
  const store = { status: () => Promise.resolve(null) } as unknown as VendorOwnerOnboardingStore;
  const service = new DefaultVendorOwnerOnboardingService(store, {
    send: () => Promise.resolve(),
  }, { authHmacKey: Buffer.from('0123456789abcdef0123456789abcdef') });

  await assert.rejects(
    () => service.status(actor, randomUUID()),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FORBIDDEN',
  );
});
