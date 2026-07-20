import assert from 'node:assert/strict';
import test from 'node:test';

import { PrismaCatalogService } from '../src/catalog/application/catalog.service.js';
import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { Actor } from '../src/common/context/request-context.js';
import { PrismaHouseholdService } from '../src/customers/application/household.service.js';
import { PrismaVendorService } from '../src/vendors/application/vendor.service.js';

const tx = {} as TransactionContext;

void test('Catalog exposes the exact active subscription selection including unit scale', async () => {
  const calls: unknown[][] = [];
  const selected = { productId: 'product', unitId: 'unit', deliverySlotId: 'slot', unitDecimalScale: 3 };
  const store = { requireSubscriptionSelection: (...args: unknown[]) => { calls.push(args); return Promise.resolve(selected); } };
  const service = new PrismaCatalogService(undefined as never, store as never, undefined as never);
  assert.deepEqual(await service.requireSubscriptionSelection(tx, 'product', 'unit', 'slot'), selected);
  assert.deepEqual(calls, [[tx, 'product', 'unit', 'slot']]);
});

void test('Customers validates exact active customer membership before route household visibility', async () => {
  const order: string[] = []; const seen: readonly string[][] = [];
  const store = {
    requireSubscriptionHousehold: () => Promise.resolve({ householdId: 'household' }),
    requireCustomerSubscriptionHousehold: (_tx: TransactionContext, householdId: string, membershipIds: readonly string[]) => {
      order.push(`household:${householdId}`); (seen as string[][]).push([...membershipIds]);
      return Promise.resolve({ householdId });
    },
  };
  const memberships = {
    requireActiveCustomerMembership: (_tx: TransactionContext, vendorId: string, membershipId: string) => {
      order.push(`membership:${vendorId}:${membershipId}`); return Promise.resolve({ membershipId, userId: 'user' });
    },
  };
  const service = new PrismaHouseholdService(undefined as never, store as never, memberships as never, undefined as never);
  const actor: Actor = {
    userId: 'user', sessionId: 'session', displayName: 'Customer', authenticationMethod: 'phone_otp', platformRoles: [],
    memberships: [
      { id: 'right', vendorId: 'vendor', vendorName: 'Vendor', role: 'customer', status: 'active' },
      { id: 'ended', vendorId: 'vendor', vendorName: 'Vendor', role: 'customer', status: 'ended' },
      { id: 'agent', vendorId: 'vendor', vendorName: 'Vendor', role: 'delivery_agent', status: 'active' },
    ],
  };
  assert.deepEqual(await service.requireSubscriptionHousehold(tx, 'household'), { householdId: 'household' });
  assert.deepEqual(await service.requireCustomerSubscriptionHousehold(tx, actor, 'vendor', 'household'), { householdId: 'household' });
  assert.deepEqual(order, ['membership:vendor:right', 'household:household']);
  assert.deepEqual(seen, [['right']]);
});

void test('Vendors exposes only the transaction-bound subscription timezone', async () => {
  const store = { getSubscriptionTimezone: () => Promise.resolve({ timezone: 'Asia/Kolkata' }) };
  const service = new PrismaVendorService(
    undefined as never, undefined as never, undefined as never, store as never,
    undefined as never, undefined as never,
  );
  assert.deepEqual(await service.getSubscriptionTimezone(tx, 'vendor'), { timezone: 'Asia/Kolkata' });
});
