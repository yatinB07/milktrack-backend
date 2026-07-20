import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError } from '../src/common/errors/application.error.js';
import { PrismaMembershipStore } from '../src/memberships/infrastructure/prisma-membership.store.js';
import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';

const vendorId = '00000000-0000-4000-8000-000000000001';
const membershipId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';

void test('customer membership attachment requires the active verified customer boundary', async () => {
  const store = new PrismaMembershipStore();
  const tx = {
    $queryRaw: () => Promise.resolve([{ id: membershipId }]),
    vendorMembership: {
      findFirst: () => Promise.resolve({ id: membershipId, userId, user: { displayName: 'Customer', identities: [{ normalizedValue: '+911234567890' }] } }),
    },
  };
  assert.deepEqual(
    await store.requireActiveCustomerMembership(wrapPrismaTransaction(tx as never), vendorId, membershipId),
    { membershipId, userId, displayName: 'Customer', phone: '+911234567890' },
  );
  const missing = new PrismaMembershipStore();
  await assert.rejects(
    missing.requireActiveCustomerMembership(wrapPrismaTransaction({ $queryRaw: () => Promise.resolve([]), vendorMembership: { findFirst: () => Promise.resolve(null) } } as never), vendorId, membershipId),
    (error: unknown) => error instanceof ApplicationError && error.code === 'CUSTOMER_MEMBERSHIP_NOT_FOUND' && error.status === 404,
  );
});

void test('customer membership history keeps linked identifiers after eligibility ends', async () => {
  const store = new PrismaMembershipStore();
  const tx = {
    vendorMembership: {
      findMany: () => Promise.resolve([{ id: membershipId, userId, user: { displayName: null, identities: [] } }]),
    },
  };
  assert.deepEqual(
    await store.customerMembershipHistory(wrapPrismaTransaction(tx as never), vendorId, [membershipId]),
    [{ membershipId, userId }],
  );
});

void test('customer membership eligibility locks the membership before checking its active customer state', async () => {
  const trace: string[] = [];
  const store = new PrismaMembershipStore();
  const tx = {
    $queryRaw: () => {
      trace.push('lock');
      return Promise.resolve([{ id: membershipId }]);
    },
    vendorMembership: {
      findFirst: () => {
        trace.push('eligibility');
        return Promise.resolve({
          id: membershipId,
          userId,
          user: { displayName: 'Customer', identities: [] },
        });
      },
    },
  };

  await store.requireActiveCustomerMembership(
    wrapPrismaTransaction(tx as never),
    vendorId,
    membershipId,
  );

  assert.deepEqual(trace, ['lock', 'eligibility']);
});
