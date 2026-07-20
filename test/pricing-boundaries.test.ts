import assert from 'node:assert/strict';
import test from 'node:test';

import { PrismaCatalogService } from '../src/catalog/application/catalog.service.js';
import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { Actor } from '../src/common/context/request-context.js';
import { PrismaHouseholdService } from '../src/customers/application/household.service.js';
import { PrismaVendorService } from '../src/vendors/application/vendor.service.js';

const tx = {} as TransactionContext;

void test('Catalog exposes transaction-bound pricing product and delivery-slot facts', async () => {
  const calls: unknown[][] = [];
  const store = {
    requirePricingProduct: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ productId: 'product', unitId: 'unit' }); },
    getPricingDeliverySlotStart: (...args: unknown[]) => { calls.push(args); return Promise.resolve('06:30'); },
  };
  const service = new PrismaCatalogService(undefined as never, store as never, undefined as never);
  assert.deepEqual(await service.requirePricingProduct(tx, 'product', 'unit'), { productId: 'product', unitId: 'unit' });
  assert.equal(await service.getPricingDeliverySlotStart(tx, 'slot'), '06:30');
  assert.deepEqual(calls, [[tx, 'product', 'unit'], [tx, 'slot']]);
});

void test('Customers exposes active household validation and exact active customer household access', async () => {
  const seen: string[][] = [];
  const validated: string[][] = [];
  const store = {
    requirePricingHousehold: () => Promise.resolve({ householdId: 'household' }),
    requireCustomerPricingHousehold: (_tx: TransactionContext, _id: string, membershipIds: readonly string[]) => {
      seen.push([...membershipIds]); return Promise.resolve({ householdId: 'household' });
    },
  };
  const memberships = {
    requireActiveCustomerMembership: (_tx: TransactionContext, vendorId: string, membershipId: string) => {
      validated.push([vendorId, membershipId]); return Promise.resolve({ membershipId, userId: 'user' });
    },
  };
  const service = new PrismaHouseholdService(undefined as never, store as never, memberships as never, undefined as never);
  const actor: Actor = {
    userId: 'user', sessionId: 'session', displayName: 'Customer', authenticationMethod: 'phone_otp', platformRoles: [],
    memberships: [
      { id: 'right', vendorId: 'vendor', vendorName: 'Vendor', role: 'customer', status: 'active' },
      { id: 'ended', vendorId: 'vendor', vendorName: 'Vendor', role: 'customer', status: 'ended' },
      { id: 'other', vendorId: 'other-vendor', vendorName: 'Other', role: 'customer', status: 'active' },
      { id: 'agent', vendorId: 'vendor', vendorName: 'Vendor', role: 'delivery_agent', status: 'active' },
    ],
  };
  assert.deepEqual(await service.requirePricingHousehold(tx, 'household'), { householdId: 'household' });
  assert.deepEqual(await service.requireCustomerPricingHousehold(tx, actor, 'vendor', 'household'), { householdId: 'household' });
  assert.deepEqual(validated, [['vendor', 'right']]);
  assert.deepEqual(seen, [['right']]);
});

void test('Vendors exposes transaction-bound timezone and currency only', async () => {
  const store = { getPricingSettings: () => Promise.resolve({ timezone: 'Asia/Kolkata', currency: 'INR' }) };
  const service = new PrismaVendorService(
    undefined as never, undefined as never, undefined as never, store as never,
    undefined as never, undefined as never,
  );
  assert.deepEqual(await service.getPricingSettings(tx, 'vendor'), { timezone: 'Asia/Kolkata', currency: 'INR' });
});
