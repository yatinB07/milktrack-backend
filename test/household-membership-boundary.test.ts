import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { Actor } from '../src/common/context/request-context.js';
import {
  PrismaHouseholdService,
  type HouseholdMemberResult,
  type HouseholdPage,
} from '../src/customers/application/household.service.js';
import type { MembershipService } from '../src/memberships/application/membership.service.js';

const vendorId = '00000000-0000-4000-8000-000000000001';
const activeCustomerMembershipId = '00000000-0000-4000-8000-000000000002';
const linkedMembershipId = '00000000-0000-4000-8000-000000000003';
const userId = '00000000-0000-4000-8000-000000000004';

const actor: Actor = {
  userId,
  sessionId: '00000000-0000-4000-8000-000000000005',
  displayName: 'Customer',
  authenticationMethod: 'phone_otp',
  platformRoles: [],
  memberships: [
    { id: activeCustomerMembershipId, vendorId, vendorName: 'Vendor', role: 'customer', status: 'active' },
    { id: linkedMembershipId, vendorId, vendorName: 'Vendor', role: 'customer', status: 'ended' },
    { id: '00000000-0000-4000-8000-000000000006', vendorId, vendorName: 'Vendor', role: 'delivery_agent', status: 'active' },
  ],
};

const transaction = {} as TransactionContext;
const authorization = {
  execute: <T>(_: unknown, work: (tx: TransactionContext) => Promise<T>): Promise<T> =>
    work(transaction),
};

void test('customer household visibility uses only the actor\'s exact active customer membership IDs', async () => {
  let receivedMembershipIds: readonly string[] | undefined;
  const households = {
    listForCustomer: (_: TransactionContext, membershipIds: readonly string[]): Promise<HouseholdPage> => {
      receivedMembershipIds = membershipIds;
      return Promise.resolve({ items: [] });
    },
  };
  const service = new PrismaHouseholdService(
    authorization,
    households as never,
    {} as MembershipService,
    {} as never,
  );

  await service.listForCustomer(actor, vendorId, {});

  assert.deepEqual(receivedMembershipIds, [activeCustomerMembershipId]);
});

void test('member display data is enriched through Memberships after Customers returns link rows', async () => {
  const member = {
    id: '00000000-0000-4000-8000-000000000007',
    householdId: '00000000-0000-4000-8000-000000000008',
    customerMembershipId: linkedMembershipId,
    status: 'active' as const,
    joinedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let requestedMembershipIds: readonly string[] | undefined;
  const households = {
    listMembers: (): Promise<{ items: readonly typeof member[] }> => Promise.resolve({ items: [member] }),
  };
  const memberships = {
    customerMembershipHistory: (
      _: TransactionContext,
      __: string,
      membershipIds: readonly string[],
    ) => {
      requestedMembershipIds = membershipIds;
      return Promise.resolve([{ membershipId: linkedMembershipId, userId, displayName: 'Customer' }]);
    },
  };
  const service = new PrismaHouseholdService(
    authorization,
    households as never,
    memberships as unknown as MembershipService,
    {} as never,
  );

  const page = await service.listMembers(actor, vendorId, member.householdId, {});

  assert.deepEqual(requestedMembershipIds, [linkedMembershipId]);
  assert.deepEqual(page.items, [{ ...member, userId, displayName: 'Customer' } satisfies HouseholdMemberResult]);
});

void test('Customers persistence does not traverse Memberships or Identity tables', () => {
  const source = readFileSync(
    new URL('../src/customers/infrastructure/prisma-household.store.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /\bcustomerMembership\s*:/);
  assert.doesNotMatch(source, /\bvendorMembership\s*:/);
  assert.doesNotMatch(source, /\bidentities\s*:/);
});
