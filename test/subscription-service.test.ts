import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { Actor } from '../src/common/context/request-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { DefaultSubscriptionService } from '../src/subscriptions/application/subscription.service.js';

const tx = {} as TransactionContext;
const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Administrator', authenticationMethod: 'administrator_mfa', platformRoles: [], memberships: [],
};
const authorization = {
  execute: (_input: unknown, operation: (current: TransactionContext) => Promise<unknown>) => operation(tx),
};
const vendors = { getSubscriptionTimezone: () => Promise.resolve({ timezone: 'Asia/Kolkata' }) };
const audits = { append: () => Promise.resolve() };

void test('create validates active dependencies and passes canonical configuration to the aggregate port', async () => {
  const calls: string[] = []; let created: unknown;
  const households = { requireSubscriptionHousehold: () => { calls.push('household'); return Promise.resolve({ householdId: 'household' }); } };
  const catalog = { requireSubscriptionSelection: () => { calls.push('catalog'); return Promise.resolve({ productId: 'product', unitId: 'unit', deliverySlotId: 'slot', unitDecimalScale: 3 }); } };
  const store = { create: (_tx: TransactionContext, input: unknown) => { calls.push('store'); created = input; return Promise.resolve({ id: 'subscription', vendorId: 'vendor', householdId: 'household', version: 1, createdAt: new Date(), updatedAt: new Date(), revisions: [] }); } };
  const service = new DefaultSubscriptionService(authorization as never, store as never, catalog as never, households as never, vendors as never, audits);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, () => service.create(actor, 'vendor', {
    householdId: 'household', productId: 'product', unitId: 'unit', deliverySlotId: 'slot', quantity: '01.250',
    weekdays: [5, 1], startDate: '2999-01-01', endDate: '2999-01-31',
  }));
  assert.deepEqual(calls, ['household', 'catalog', 'store']);
  assert.ok(created);
  assert.deepEqual(created, {
    id: (created as { id: string }).id, vendorId: 'vendor', householdId: 'household', productId: 'product', unitId: 'unit',
    deliverySlotId: 'slot', quantity: '1.25', weekdays: [1, 5], effectiveFrom: '2999-01-01', effectiveTo: '2999-02-01',
    createdBy: actor.userId,
  });
});

void test('pause and cancel use retained locked configuration without revalidating unavailable dependencies', async () => {
  const dependencies = { household: 0, catalog: 0 };
  const households = { requireSubscriptionHousehold: () => { dependencies.household++; return Promise.resolve({ householdId: 'household' }); } };
  const catalog = { requireSubscriptionSelection: () => { dependencies.catalog++; return Promise.resolve({ unitDecimalScale: 3 }); } };
  const locked = {
    id: 'subscription', vendorId: 'vendor', householdId: 'household', version: 1,
    revisions: [],
    selected: { productId: 'product', unitId: 'unit', deliverySlotId: 'slot', quantity: '1', weekdays: [1], status: 'active', effectiveFrom: '2999-01-01' },
  };
  const transitions: unknown[] = [];
  const store = {
    lockForMutation: () => Promise.resolve(locked),
    replacePlan: (_tx: TransactionContext, input: unknown) => { transitions.push(input); return Promise.resolve({ ...locked, version: 2, revisions: [], replacementRevisionId: 'replacement', supersededRevisionIds: [], supersededRevisionCount: 0 }); },
  };
  const service = new DefaultSubscriptionService(authorization as never, store as never, catalog as never, households as never, vendors as never, audits);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, async () => {
    await service.pause(actor, 'vendor', 'subscription', { effectiveDate: '2999-01-01', expectedVersion: 1, reason: 'Holiday' });
    await service.cancel(actor, 'vendor', 'subscription', { effectiveDate: '2999-01-01', expectedVersion: 1, reason: 'Stopped service' });
  });
  assert.deepEqual(dependencies, { household: 0, catalog: 0 });
  assert.equal(transitions.length, 2);
});

void test('completed terminal roots delete through the root lock without requiring a selected revision', async () => {
  const completed = { id: 'subscription', vendorId: 'vendor', householdId: 'household', version: 1, createdAt: new Date(), updatedAt: new Date(), revisions: [{
    id: 'old', vendorId: 'vendor', subscriptionId: 'subscription', productId: 'product', unitId: 'unit', deliverySlotId: 'slot',
    quantity: '1', weekdays: [1], status: 'active', effectiveFrom: '2000-01-01', effectiveTo: '2000-02-01', createdBy: actor.userId,
    createdAt: new Date(), updatedAt: new Date(),
  }] } as const;
  let deleted = false;
  const store = {
    lockRoot: () => Promise.resolve(completed),
    softDelete: () => { deleted = true; return Promise.resolve({ ...completed, version: 2, deletedAt: new Date() }); },
  };
  const service = new DefaultSubscriptionService(authorization as never, store as never, {} as never, {} as never, vendors as never, audits);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, () => service.softDelete(actor, 'vendor', 'subscription', { expectedVersion: 1, reason: 'Archive complete service' }));
  assert.equal(deleted, true);
});

void test('customer list/history stay household-scoped and remove administrative revision metadata', async () => {
  let listArguments: unknown[] = [];
  const revision = {
    id: 'revision', vendorId: 'vendor', subscriptionId: 'subscription', productId: 'product', unitId: 'unit', deliverySlotId: 'slot',
    quantity: '1', weekdays: [1], status: 'cancelled' as const, effectiveFrom: '2000-01-01', createdBy: actor.userId,
    supersessionReason: 'Internal correction', createdAt: new Date(), updatedAt: new Date(),
  };
  const aggregate = { id: 'subscription', vendorId: 'vendor', householdId: 'household', version: 1, createdAt: new Date(), updatedAt: new Date(), revisions: [revision] };
  const store = {
    list: (...args: unknown[]) => { listArguments = args; return Promise.resolve({ items: [aggregate] }); },
    history: () => Promise.resolve({ items: [revision] }),
  };
  const households = { requireCustomerSubscriptionHousehold: () => Promise.resolve({ householdId: 'household' }) };
  const service = new DefaultSubscriptionService(authorization as never, store as never, {} as never, households as never, vendors as never, audits);
  const customer = { ...actor, authenticationMethod: 'phone_otp' as const };
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, async () => {
    const page = await service.listCustomer(customer, 'vendor', 'household', { status: 'cancelled', limit: 25 });
    assert.equal('createdBy' in page.items[0].revisions[0], false);
    assert.equal('supersessionReason' in page.items[0].revisions[0], false);
    const history = await service.historyCustomer(customer, 'vendor', 'household', 'subscription', {});
    assert.equal('createdBy' in history.items[0], false);
    assert.equal('supersessionReason' in history.items[0], false);
  });
  assert.deepEqual(listArguments.slice(1), [{ status: 'cancelled', limit: 25 }, listArguments[2], 'household']);
});

void test('mutation audit records the exact replacement and superseded revision IDs with the old safe plan', async () => {
  const oldRevision = {
    id: 'old', vendorId: 'vendor', subscriptionId: 'subscription', productId: 'product', unitId: 'unit', deliverySlotId: 'slot',
    quantity: '1', weekdays: [1], status: 'active' as const, effectiveFrom: '2999-01-01', createdBy: actor.userId,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const locked = { id: 'subscription', vendorId: 'vendor', householdId: 'household', version: 1, createdAt: new Date(), updatedAt: new Date(), revisions: [oldRevision], selected: oldRevision };
  const replacement = { ...oldRevision, id: 'replacement', status: 'paused' as const, createdAt: new Date(Date.now() - 1000) };
  const laterSuperseded = { ...oldRevision, id: 'later', supersededAt: new Date(), supersededByRevisionId: 'replacement', supersessionReason: 'Pause' };
  const store = {
    lockForMutation: () => Promise.resolve(locked),
    replacePlan: () => Promise.resolve({ ...locked, version: 2, revisions: [replacement, laterSuperseded], replacementRevisionId: 'replacement', supersededRevisionIds: ['old', 'later'], supersededRevisionCount: 2 }),
  };
  const events: unknown[] = []; const auditWriter = { append: (_tx: TransactionContext, event: unknown) => { events.push(event); return Promise.resolve(); } };
  const service = new DefaultSubscriptionService(authorization as never, store as never, {} as never, {} as never, vendors as never, auditWriter);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, () => service.pause(actor, 'vendor', 'subscription', { effectiveDate: '2999-01-01', expectedVersion: 1, reason: 'Pause' }));
  const event = events[0] as { oldValue: { plan: unknown[] }; newValue: { revisionId: string; supersededRevisionIds: string[] } };
  assert.equal(event.newValue.revisionId, 'replacement');
  assert.deepEqual(event.newValue.supersededRevisionIds, ['old', 'later']);
  assert.equal(event.oldValue.plan.length, 1);
  assert.equal('createdBy' in (event.oldValue.plan[0] as object), false);
});
