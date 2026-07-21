import assert from 'node:assert/strict';
import test from 'node:test';

import type { Actor } from '../src/common/context/request-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { CustomerSubscriptionController, VendorSubscriptionController } from '../src/subscriptions/http/subscription.controller.js';

const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'User', authenticationMethod: 'administrator_mfa', platformRoles: [], memberships: [],
};
const revision = {
  id: '00000000-0000-4000-8000-000000000010', vendorId: '00000000-0000-4000-8000-000000000020',
  subscriptionId: '00000000-0000-4000-8000-000000000030', productId: '00000000-0000-4000-8000-000000000040',
  unitId: '00000000-0000-4000-8000-000000000050', deliverySlotId: '00000000-0000-4000-8000-000000000060',
  quantity: '1.25', weekdays: [1, 5], status: 'active' as const, effectiveFrom: '2030-01-01', effectiveTo: '2030-02-01', createdBy: actor.userId,
  supersessionReason: 'Corrected plan', createdAt: new Date('2030-01-01T00:00:00Z'), updatedAt: new Date('2030-01-01T00:00:00Z'),
};
const result = {
  id: revision.subscriptionId, vendorId: revision.vendorId, householdId: '00000000-0000-4000-8000-000000000070',
  version: 1, status: 'future' as const, createdAt: revision.createdAt, updatedAt: revision.updatedAt, revisions: [revision],
};

void test('vendor controller maps explicit subscription dates and mutation supersession count', async () => {
  const service = { create: () => Promise.resolve({ ...result, supersededRevisionCount: 2 }) };
  const controller = new VendorSubscriptionController(service as never);
  const response = await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003', actor }, () => controller.create(revision.vendorId, {
    householdId: result.householdId, productId: revision.productId, unitId: revision.unitId, deliverySlotId: revision.deliverySlotId,
    quantity: '1.25', weekdays: [1, 5], startDate: '2030-01-01',
  }));
  assert.equal(response.createdAt, '2030-01-01T00:00:00.000Z');
  assert.equal(response.revisions[0]?.startDate, '2030-01-01');
  assert.equal(response.revisions[0]?.endDate, '2030-01-31');
  assert.equal('effectiveFrom' in response.revisions[0], false);
  assert.equal('effectiveTo' in response.revisions[0], false);
  assert.equal(response.supersededRevisionCount, 2);
});

void test('vendor controller normalizes lifecycle only for subscription roots', async () => {
  const calls: unknown[][] = [];
  const deleted = { ...result, lifecycle: 'deleted' as const };
  const service = { list: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ items: [deleted] }); }, get: (...args: unknown[]) => { calls.push(args); return Promise.resolve(deleted); } };
  const controller = new VendorSubscriptionController(service as never);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003', actor }, async () => {
    const page = await controller.list(revision.vendorId, {});
    const detail = await controller.get(revision.vendorId, revision.subscriptionId, { lifecycle: 'deleted' });
    assert.equal(page.items[0]?.lifecycle, 'deleted');
    assert.equal(detail.lifecycle, 'deleted');
    assert.equal('deletedAt' in detail, false);
  });
  assert.deepEqual(calls.map((args) => args.at(-1)), [{ lifecycle: 'current' }, 'deleted']);
});

void test('customer controller returns household-bound safe revision history', async () => {
  let args: unknown[] = [];
  const { createdBy: _createdBy, supersessionReason: _supersessionReason, ...safeRevision } = revision;
  void _createdBy; void _supersessionReason;
  const service = { historyCustomer: (...current: unknown[]) => { args = current; return Promise.resolve({ items: [safeRevision] }); } };
  const controller = new CustomerSubscriptionController(service as never);
  const response = await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003', actor }, () => controller.history(revision.vendorId, result.householdId, revision.subscriptionId, {}));
  assert.equal('createdBy' in response.items[0], false);
  assert.equal('supersessionReason' in response.items[0], false);
  assert.equal(response.items[0]?.startDate, '2030-01-01');
  assert.equal(response.items[0]?.endDate, '2030-01-31');
  assert.equal('effectiveFrom' in response.items[0], false);
  assert.equal('effectiveTo' in response.items[0], false);
  assert.deepEqual(args.slice(1, 4), [revision.vendorId, result.householdId, revision.subscriptionId]);
});
