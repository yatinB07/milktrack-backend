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
const requestedSubscriptionId = '00000000-0000-4000-8000-000000000016';
const tx = {} as TransactionContext;

void test('preview is household-scoped and advisory while create revalidates and persists an accepted request', async () => {
  const calls: string[] = [];
  const notifications: unknown[] = [];
  const store = {
    preview: () => { calls.push('preview'); return Promise.resolve({ items: [{ subscriptionId, deliverySlotId: slotId, serviceDate: '2030-01-02', cutoffAt: new Date('2030-01-01T00:00:00.000Z'), timing: 'on_time', proposedBehavior: 'accept' }], onTimeCount: 1, lateCount: 0 }); },
    assertNoOverlap: () => { calls.push('overlap'); return Promise.resolve(); },
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
    {
      listAffected: () => { throw new Error('Unexpected bounded delivery lookup'); },
      synchronize: () => { throw new Error('Unexpected bounded delivery synchronization'); },
      applyCustomerLeave: () => { calls.push('project'); return Promise.resolve(); },
      reverseCustomerLeave: () => Promise.resolve(),
    },
    { append: (_tx: TransactionContext, value: unknown) => { calls.push('notification'); notifications.push(value); return Promise.resolve(); } },
    { project: () => { calls.push('routing'); return Promise.resolve([{ routeId: 'route', routeVersion: 1, deliverySlotId: slotId, stops: [{ stopId: 'stop', householdId, sequence: 1 }], assignment: { assignmentId: 'assignment', agentMembershipId } }]); }, projectRoute: () => Promise.resolve(undefined) },
    { customerMembershipHistory: () => { calls.push('membership'); return Promise.resolve([{ membershipId: agentMembershipId, userId: agentUserId }]); } } as never,
  );
  const selection = { startDate: '2030-01-02', endDate: '2030-01-03', subscriptionIds: [subscriptionId] };
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000099' }, async () => {
    const preview = await service.preview(actor, vendorId, householdId, selection);
    assert.equal(preview.onTimeCount, 1);
    assert.deepEqual(calls, ['household', 'preview', 'overlap']);
    const created = await service.create(actor, vendorId, householdId, selection);
    assert.equal(created.currentStatus, 'accepted');
  });
  assert.deepEqual(calls, ['household', 'preview', 'overlap', 'household', 'lock', 'preview', 'create', 'preview', 'effective', 'project', 'routing', 'membership', 'audit', 'notification', 'notification']);
  assert.equal(notifications.every((value) => (value as { householdId?: string }).householdId === householdId), true);
});

void test('amend and cancel persist late old-to-new transitions and retain removed associations', async () => {
  const persisted: Array<Record<string, unknown>> = [];
  const current = request();
  const preview = (_tx: TransactionContext, input: { subscriptionIds: readonly string[] }) => Promise.resolve({
    items: input.subscriptionIds.map((id) => ({
      subscriptionId: id, deliverySlotId: slotId, serviceDate: '2030-01-02', cutoffAt: new Date('2030-01-01T00:00:00.000Z'),
      timing: 'late' as const, proposedBehavior: 'pending_approval' as const,
    })),
    onTimeCount: 0,
    lateCount: input.subscriptionIds.length,
  });
  const store = {
    getRequest: () => Promise.resolve(current),
    lockSubscriptions: () => Promise.resolve(),
    preview,
    createRevision: (_tx: TransactionContext, input: Record<string, unknown>) => {
      persisted.push(input);
      return Promise.resolve({ ...current, status: input.status, version: current.version + 1, currentRevisionId: input.revisionId });
    },
    isEffectivelyOnLeave: () => Promise.resolve(false),
  };
  const service = new DefaultLeaveService(
    { execute: (_input: unknown, operation: (current: TransactionContext) => Promise<unknown>) => operation(tx) } as never,
    { requireCustomerSubscriptionHousehold: () => Promise.resolve({ householdId }) } as never,
    store as never,
    { getDeliveryPolicyForTransaction: () => Promise.resolve({ vendorId, skipCutoffMinutes: 60, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, version: 1 }), getSubscriptionTimezone: () => Promise.resolve({ timezone: 'UTC' }) } as never,
    { append: () => Promise.resolve() },
    { applyCustomerLeave: () => Promise.resolve(), reverseCustomerLeave: () => Promise.resolve() } as never,
    { append: () => Promise.resolve() },
    { project: () => Promise.resolve([]), projectRoute: () => Promise.resolve(undefined) },
    { customerMembershipHistory: () => Promise.resolve([]) } as never,
  );
  (service as unknown as { now: () => Date }).now = () => new Date('2030-01-01T23:00:00.000Z');

  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000098' }, async () => {
    await service.amend(actor, vendorId, householdId, current.id, {
      startDate: '2030-01-02', endDate: '2030-01-02', subscriptionIds: [requestedSubscriptionId], expectedVersion: current.version,
    });
    await service.cancel(actor, vendorId, householdId, current.id, { expectedVersion: current.version });
  });

  assert.deepEqual(persisted[0]?.subscriptions, [
    { subscriptionId, selected: false },
    { subscriptionId: requestedSubscriptionId, selected: true },
  ]);
  assert.deepEqual((persisted[0]?.decisions as Array<Record<string, unknown>>).map(({ subscriptionId: id, previousEffectiveStatus, requestedEffectiveStatus, status }) => ({ id, previousEffectiveStatus, requestedEffectiveStatus, status })), [
    { id: subscriptionId, previousEffectiveStatus: 'skipped_by_customer', requestedEffectiveStatus: 'scheduled', status: 'pending' },
    { id: requestedSubscriptionId, previousEffectiveStatus: 'scheduled', requestedEffectiveStatus: 'skipped_by_customer', status: 'pending' },
  ]);
  assert.equal(persisted[1]?.status, 'pending_approval');
  assert.deepEqual(persisted[1]?.subscriptions, [{ subscriptionId, selected: false }]);
  assert.deepEqual((persisted[1]?.decisions as Array<Record<string, unknown>>).map(({ previousEffectiveStatus, requestedEffectiveStatus, status }) => ({ previousEffectiveStatus, requestedEffectiveStatus, status })), [
    { previousEffectiveStatus: 'skipped_by_customer', requestedEffectiveStatus: 'scheduled', status: 'pending' },
  ]);
});

void test('late transition derivation bounds a hundred-year request to the seven-day cutoff horizon', async () => {
  const previewEnds: string[] = [];
  const store = {
    lockSubscriptions: () => Promise.resolve(),
    preview: (_tx: TransactionContext, input: { endDate: string }) => {
      previewEnds.push(input.endDate);
      return Promise.resolve({ items: [], onTimeCount: 5_200, lateCount: 1 });
    },
    createRevision: () => Promise.reject(new Error('status derived')),
  };
  const service = new DefaultLeaveService(
    { execute: (_input: unknown, operation: (current: TransactionContext) => Promise<unknown>) => operation(tx) } as never,
    { requireCustomerSubscriptionHousehold: () => Promise.resolve({ householdId }) } as never,
    store as never,
    { getDeliveryPolicyForTransaction: () => Promise.resolve({ vendorId, skipCutoffMinutes: 10_080, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, version: 1 }), getSubscriptionTimezone: () => Promise.resolve({ timezone: 'UTC' }) } as never,
    { append: () => Promise.resolve() },
    {} as never,
    { append: () => Promise.resolve() },
    {} as never,
    {} as never,
  );
  (service as unknown as { now: () => Date }).now = () => new Date('2029-12-31T12:00:00.000Z');

  await assert.rejects(service.create(actor, vendorId, householdId, {
    startDate: '2030-01-01', endDate: '2129-12-31', subscriptionIds: [subscriptionId],
  }), /status derived/u);
  assert.deepEqual(previewEnds, ['2129-12-31', '2030-01-07']);
});

void test('subsequent amend and cancel retain effectively skipped unselected associations', async () => {
  const replacementId = requestedSubscriptionId;
  const nextId = '00000000-0000-4000-8000-000000000017';
  const current = {
    ...request(), status: 'partially_pending' as const,
    revisions: [{
      ...request().revisions[0], action: 'amend' as const, subscriptions: [
        { subscriptionId, selected: false }, { subscriptionId: replacementId, selected: true },
      ], subscriptionIds: [replacementId], decisions: [{
        id: '00000000-0000-4000-8000-000000000018', vendorId, leaveRequestRevisionId: request().revisions[0].id,
        subscriptionId, serviceDate: '2030-01-02', deliverySlotId: slotId, status: 'rejected' as const,
        previousEffectiveStatus: 'skipped_by_customer' as const, requestedEffectiveStatus: 'scheduled' as const,
        version: 1, createdAt: new Date('2030-01-01T00:00:00.000Z'),
      }],
    }],
  };
  const persisted: Array<Record<string, unknown>> = [];
  const locked: string[][] = [];
  const store = {
    getRequest: () => Promise.resolve(current),
    lockSubscriptions: (_tx: TransactionContext, _vendorId: string, ids: readonly string[]) => { locked.push([...ids]); return Promise.resolve(); },
    preview: (_tx: TransactionContext, input: { subscriptionIds: readonly string[] }) => Promise.resolve({
      items: input.subscriptionIds.map((id) => ({ subscriptionId: id, deliverySlotId: slotId, serviceDate: '2030-01-02',
        cutoffAt: new Date(), timing: 'late' as const, proposedBehavior: 'pending_approval' as const })),
      onTimeCount: 0, lateCount: input.subscriptionIds.length,
    }),
    createRevision: (_tx: TransactionContext, input: Record<string, unknown>) => { persisted.push(input); return Promise.resolve({ ...current, status: input.status }); },
    isEffectivelyOnLeave: () => Promise.resolve(false),
  };
  const service = new DefaultLeaveService(
    { execute: (_input: unknown, operation: (currentTx: TransactionContext) => Promise<unknown>) => operation(tx) } as never,
    { requireCustomerSubscriptionHousehold: () => Promise.resolve({ householdId }) } as never, store as never,
    { getDeliveryPolicyForTransaction: () => Promise.resolve({ vendorId, skipCutoffMinutes: 60, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, version: 1 }), getSubscriptionTimezone: () => Promise.resolve({ timezone: 'UTC' }) } as never,
    { append: () => Promise.resolve() }, { applyCustomerLeave: () => Promise.resolve(), reverseCustomerLeave: () => Promise.resolve() } as never,
    { append: () => Promise.resolve() }, { project: () => Promise.resolve([]), projectRoute: () => Promise.resolve(undefined) },
    { customerMembershipHistory: () => Promise.resolve([]) } as never,
  );
  (service as unknown as { now: () => Date }).now = () => new Date('2030-01-01T23:00:00.000Z');

  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000097' }, async () => {
    await service.amend(actor, vendorId, householdId, current.id, {
      startDate: '2030-01-02', endDate: '2030-01-02', subscriptionIds: [nextId], expectedVersion: current.version,
    });
    await service.cancel(actor, vendorId, householdId, current.id, { expectedVersion: current.version });
  });

  assert.deepEqual(locked, [[subscriptionId, replacementId, nextId].sort(), [subscriptionId, replacementId].sort()]);
  assert.deepEqual(persisted[0]?.subscriptions, [
    { subscriptionId, selected: false }, { subscriptionId: replacementId, selected: false }, { subscriptionId: nextId, selected: true },
  ]);
  assert.deepEqual(persisted[1]?.subscriptions, [
    { subscriptionId, selected: false }, { subscriptionId: replacementId, selected: false },
  ]);
});

function request() {
  return {
    id: '00000000-0000-4000-8000-000000000020', vendorId, householdId, status: 'accepted' as const, version: 1,
    createdAt: new Date('2030-01-01T00:00:00.000Z'), updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    revisions: [{ id: '00000000-0000-4000-8000-000000000021', action: 'create' as const, startDate: '2030-01-02', endDate: '2030-01-03', source: 'customer' as const, createdBy: actor.userId, status: 'accepted' as const, createdAt: new Date('2030-01-01T00:00:00.000Z'), subscriptions: [{ subscriptionId, selected: true }], subscriptionIds: [subscriptionId] }],
  };
}
