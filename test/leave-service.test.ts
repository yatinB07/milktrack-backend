import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { DefaultLeaveService } from '../src/leave/application/leave.service.js';

const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Customer', authenticationMethod: 'phone_otp', platformRoles: [], memberships: [],
};
const vendorId = '00000000-0000-4000-8000-000000000010';
const householdId = '00000000-0000-4000-8000-000000000011';
const subscriptionId = '00000000-0000-4000-8000-000000000012';
const slotId = '00000000-0000-4000-8000-000000000013';
const agentMembershipId = '00000000-0000-4000-8000-000000000014';
const agentUserId = '00000000-0000-4000-8000-000000000015';
const tx = {} as TransactionContext;

void test('preview is household-scoped and advisory while create revalidates and persists an accepted request', async () => {
  const calls: string[] = [];
  const store = {
    preview: () => { calls.push('preview'); return Promise.resolve({ items: [{ subscriptionId, deliverySlotId: slotId, serviceDate: '2030-01-02', cutoffAt: new Date('2030-01-01T00:00:00.000Z'), timing: 'on_time', proposedBehavior: 'accept' }], onTimeCount: 1, lateCount: 0 }); },
    lockSubscriptions: () => { calls.push('lock'); return Promise.resolve(); },
    createRevision: () => { calls.push('create'); return Promise.resolve(request()); },
    isEffectivelyOnLeave: () => { calls.push('effective'); return Promise.resolve(true); },
  };
  const service = new DefaultLeaveService(
    { execute: (_input: unknown, operation: (current: TransactionContext) => Promise<unknown>) => operation(tx) } as never,
    { requireCustomerSubscriptionHousehold: () => { calls.push('household'); return Promise.resolve({ householdId }); } } as never,
    store as never,
    { getDeliveryPolicyForTransaction: () => Promise.resolve({ vendorId, skipCutoffMinutes: 60, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, version: 1 }), getSubscriptionTimezone: () => Promise.resolve({ timezone: 'Asia/Kolkata' }) } as never,
    { append: () => { calls.push('audit'); return Promise.resolve(); } },
    { applyCustomerLeave: () => { calls.push('project'); return Promise.resolve(); }, reverseCustomerLeave: () => Promise.resolve() },
    { append: () => { calls.push('notification'); return Promise.resolve(); } },
    { project: () => { calls.push('routing'); return Promise.resolve([{ routeId: 'route', routeVersion: 1, deliverySlotId: slotId, stops: [{ stopId: 'stop', householdId, sequence: 1 }], assignment: { assignmentId: 'assignment', agentMembershipId } }]); }, projectRoute: () => Promise.resolve(undefined) },
    { customerMembershipHistory: () => { calls.push('membership'); return Promise.resolve([{ membershipId: agentMembershipId, userId: agentUserId }]); } } as never,
  );
  const selection = { startDate: '2030-01-02', endDate: '2030-01-03', subscriptionIds: [subscriptionId] };
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000099' }, async () => {
    const preview = await service.preview(actor, vendorId, householdId, selection);
    assert.equal(preview.onTimeCount, 1);
    assert.deepEqual(calls, ['household', 'preview']);
    const created = await service.create(actor, vendorId, householdId, selection);
    assert.equal(created.currentStatus, 'accepted');
  });
  assert.deepEqual(calls, ['household', 'preview', 'household', 'lock', 'preview', 'create', 'preview', 'effective', 'project', 'routing', 'membership', 'audit', 'notification', 'notification']);
});

function request() {
  return {
    id: '00000000-0000-4000-8000-000000000020', vendorId, householdId, status: 'accepted' as const, version: 1,
    createdAt: new Date('2030-01-01T00:00:00.000Z'), updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    revisions: [{ id: '00000000-0000-4000-8000-000000000021', action: 'create' as const, startDate: '2030-01-02', endDate: '2030-01-03', source: 'customer' as const, createdBy: actor.userId, status: 'accepted' as const, createdAt: new Date('2030-01-01T00:00:00.000Z'), subscriptionIds: [subscriptionId] }],
  };
}
