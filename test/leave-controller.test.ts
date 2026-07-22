import assert from 'node:assert/strict';
import test from 'node:test';

import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { CustomerLeaveController } from '../src/leave/http/customer-leave.controller.js';
import { VendorLeaveController } from '../src/leave/http/vendor-leave.controller.js';

const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Customer', authenticationMethod: 'phone_otp', platformRoles: [], memberships: [],
};
const vendorId = '00000000-0000-4000-8000-000000000010';
const householdId = '00000000-0000-4000-8000-000000000011';
const requestId = '00000000-0000-4000-8000-000000000012';

void test('customer and vendor leave controllers expose audience-safe timelines and actions', async () => {
  const currentRevisionId = '00000000-0000-4000-8000-000000000013';
  const unsafe = {
    id: requestId, vendorId, householdId, currentStatus: 'accepted' as const, currentRevisionId, version: 1,
    createdAt: new Date('2030-01-01T00:00:00.000Z'), updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    availableActions: ['amend', 'cancel'] as const, phone: '+910000000000', address: 'Private', token: 'secret', gps: { latitude: 1 },
    revisions: [
      { id: currentRevisionId, action: 'create' as const, startDate: '2030-01-02', endDate: '2030-01-03', source: 'customer' as const,
        createdBy: actor.userId, status: 'accepted' as const, createdAt: new Date('2030-01-01T00:00:00.000Z'), subscriptions: [], subscriptionIds: [],
        auditPayload: { private: true }, decisions: [
          { id: '00000000-0000-4000-8000-000000000015', subscriptionId: '00000000-0000-4000-8000-000000000016', deliverySlotId: '00000000-0000-4000-8000-000000000017',
            serviceDate: '2030-01-03', status: 'pending' as const, previousEffectiveStatus: 'scheduled' as const, requestedEffectiveStatus: 'skipped_by_customer' as const,
            version: 1, createdAt: new Date('2030-01-01T01:00:00.000Z'), availableActions: ['approve', 'reject'] as const, prismaOnly: 'hidden' },
        ] },
      { id: '00000000-0000-4000-8000-000000000014', action: 'create' as const, startDate: '2030-01-01', endDate: '2030-01-01', source: 'vendor_admin' as const,
        createdBy: actor.userId, status: 'pending_approval' as const, createdAt: new Date('2029-12-31T00:00:00.000Z'), subscriptions: [], subscriptionIds: [], decisions: [
          { id: '00000000-0000-4000-8000-000000000018', subscriptionId: '00000000-0000-4000-8000-000000000016', deliverySlotId: '00000000-0000-4000-8000-000000000017',
            serviceDate: '2030-01-01', status: 'pending' as const, previousEffectiveStatus: 'scheduled' as const, requestedEffectiveStatus: 'skipped_by_customer' as const,
            version: 1, createdAt: new Date('2029-12-31T01:00:00.000Z'), availableActions: [] as const },
        ] },
    ],
  };
  const service = { getCustomer: () => Promise.resolve(unsafe), getVendorRequest: () => Promise.resolve(unsafe) };
  const customer = new CustomerLeaveController(service as never);
  const vendor = new VendorLeaveController(service as never);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000099', actor }, async () => {
    const customerDetail = await customer.get(vendorId, householdId, requestId);
    assert.deepEqual(customerDetail.availableActions, ['amend', 'cancel']);
    assert.equal(customerDetail.revisions[0]?.source, 'customer');
    assert.equal(customerDetail.revisions[0]?.createdBy, actor.userId);
    assert.equal(customerDetail.revisions[0]?.decisions[0]?.currentStatus, 'pending');
    assert.equal('availableActions' in customerDetail.revisions[0].decisions[0], false);
    const vendorDetail = await vendor.getRequest(vendorId, requestId);
    assert.equal('availableActions' in vendorDetail, false);
    assert.deepEqual(vendorDetail.revisions[0]?.decisions[0]?.availableActions, ['approve', 'reject']);
    assert.deepEqual(vendorDetail.revisions[1]?.decisions[0]?.availableActions, []);
    for (const detail of [customerDetail, vendorDetail]) {
      const serialized = JSON.stringify(detail);
      for (const unsafeKey of ['auditPayload', 'phone', 'address', 'token', 'gps', 'prismaOnly']) assert.equal(serialized.includes(unsafeKey), false);
    }
  });
  const cancelled = new CustomerLeaveController({ getCustomer: () => Promise.resolve({ ...unsafe, currentStatus: 'cancelled', availableActions: [] }) } as never);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000099', actor }, async () => {
    assert.deepEqual((await cancelled.get(vendorId, householdId, requestId)).availableActions, []);
  });
});

void test('customer preview forwards cursor pagination unchanged', async () => {
  const calls: unknown[][] = [];
  const controller = new CustomerLeaveController({
    preview: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ timezone: 'Asia/Kolkata', skipCutoffMinutes: 60, lateLeavePolicy: 'approval', onTimeCount: 0, lateCount: 0, items: [] });
    },
  } as never);
  const body = { startDate: '2030-01-02', endDate: '2030-01-03', subscriptionIds: [], cursor: 'opaque-page', limit: 25 };
  await requestContextStore.run({ correlationId: 'correlation', actor }, () => controller.preview(vendorId, householdId, body));
  assert.deepEqual(calls, [[actor, vendorId, householdId, body]]);
});
