import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import type { DeliveryLeaveCandidate } from '../src/delivery/application/delivery.store.js';
import { DefaultLeaveService } from '../src/leave/application/leave.service.js';
import type { LeaveRequestRecord, LeaveRevisionDecisionRecord, LeaveRevisionRecord } from '../src/leave/application/leave.store.js';
import type { SubscriptionLabelReference } from '../src/subscriptions/application/subscription-label.reader.js';

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
    effectiveOccurrenceKeys: () => { calls.push('effective'); return Promise.resolve(new Set([deliveryOccurrenceKey(deliveryCandidate(1, '2030-01-02'))])); },
  };
  const service = new DefaultLeaveService(
    { execute: (_input: unknown, operation: (current: TransactionContext) => Promise<unknown>) => operation(tx) } as never,
    { requireCustomerSubscriptionHousehold: () => { calls.push('household'); return Promise.resolve({ householdId }); } } as never,
    store as never,
    { getDeliveryPolicyForTransaction: () => Promise.resolve({ vendorId, skipCutoffMinutes: 60, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, version: 1 }), getSubscriptionTimezone: () => Promise.resolve({ timezone: 'Asia/Kolkata' }) } as never,
    { append: () => { calls.push('audit'); return Promise.resolve(); } },
    {
      listAffected: () => { calls.push('list'); return Promise.resolve({ items: [deliveryCandidate(1, '2030-01-02')] }); },
      synchronize: () => { calls.push('project'); return Promise.resolve({ agentMembershipIds: [agentMembershipId] }); },
      applyCustomerLeave: () => Promise.resolve(),
      reverseCustomerLeave: () => Promise.resolve(),
    },
    { append: (_tx: TransactionContext, value: unknown) => { calls.push('notification'); notifications.push(value); return Promise.resolve(); } },
    { project: () => { calls.push('routing'); return Promise.resolve([{ routeId: 'route', routeVersion: 1, deliverySlotId: slotId, stops: [{ stopId: 'stop', householdId, sequence: 1 }], assignment: { assignmentId: 'assignment', agentMembershipId } }]); }, projectRoute: () => Promise.resolve(undefined) },
    { customerMembershipHistory: () => { calls.push('membership'); return Promise.resolve([{ membershipId: agentMembershipId, userId: agentUserId }]); } } as never,
    { read: (_tx: TransactionContext, input: { references: readonly SubscriptionLabelReference[] }) => { calls.push('labels'); return Promise.resolve(labelMatches(input.references)); } },
  );
  const selection = { startDate: '2030-01-02', endDate: '2030-01-03', subscriptionIds: [subscriptionId] };
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000099' }, async () => {
    const preview = await service.preview(actor, vendorId, householdId, selection);
    assert.equal(preview.onTimeCount, 1);
    assert.deepEqual(calls, ['household', 'preview', 'overlap', 'labels']);
    const created = await service.create(actor, vendorId, householdId, selection);
    assert.equal(created.currentStatus, 'accepted');
  });
  assert.deepEqual(calls, ['household', 'preview', 'overlap', 'labels', 'household', 'lock', 'preview', 'create', 'list', 'effective', 'project', 'membership', 'audit', 'notification', 'notification', 'labels']);
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
    { listAffected: () => Promise.resolve({ items: [] }), synchronize: () => Promise.resolve({ agentMembershipIds: [] }),
      applyCustomerLeave: () => Promise.resolve(), reverseCustomerLeave: () => Promise.resolve() },
    { append: () => Promise.resolve() },
    { project: () => Promise.resolve([]), projectRoute: () => Promise.resolve(undefined) },
    { customerMembershipHistory: () => Promise.resolve([]) } as never,
    { read: (_tx: TransactionContext, input: { references: readonly SubscriptionLabelReference[] }) => Promise.resolve(labelMatches(input.references)) },
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
    { read: (_tx: TransactionContext, input: { references: readonly SubscriptionLabelReference[] }) => Promise.resolve(labelMatches(input.references)) },
  );
  (service as unknown as { now: () => Date }).now = () => new Date('2029-12-31T12:00:00.000Z');

  await assert.rejects(service.create(actor, vendorId, householdId, {
    startDate: '2030-01-01', endDate: '2129-12-31', subscriptionIds: [subscriptionId],
  }), /status derived/u);
  assert.deepEqual(previewEnds, ['2129-12-31', '2030-01-07']);
});

void test('hundred-year leave synchronizes only two existing delivery rows without preview or routing enumeration', async () => {
  const candidates = [deliveryCandidate(1, '2030-01-02'), deliveryCandidate(2, '2129-12-30')];
  const labelCalls: SubscriptionLabelReference[][] = [];
  const membershipCalls: string[][] = [];
  const notifiedUsers: string[] = [];
  let persisted = false;
  let previewPageCallsForFullRange = 0;
  let deliveryCandidateCount = 0;
  let maxCandidatePageSize = 0;
  let routingProjectCalls = 0;
  const service = boundedService({
    preview: () => {
      if (persisted) previewPageCallsForFullRange += 1;
      return Promise.resolve({ items: [], onTimeCount: 2, lateCount: 0 });
    },
    lockSubscriptions: () => Promise.resolve(),
    createRevision: () => { persisted = true; return Promise.resolve(request()); },
    effectiveOccurrenceKeys: (_tx: TransactionContext, input: { candidates: readonly DeliveryLeaveCandidate[] }) =>
      Promise.resolve(new Set(input.candidates.map(deliveryOccurrenceKey))),
  }, {
    listAffected: () => Promise.resolve({ items: candidates }),
    synchronize: (_tx: TransactionContext, _actor: unknown, states: readonly DeliveryLeaveCandidate[]) => {
      deliveryCandidateCount += states.length;
      maxCandidatePageSize = Math.max(maxCandidatePageSize, states.length);
      return Promise.resolve({ agentMembershipIds: [agentMembershipId, agentMembershipId] });
    },
  }, {
    routing: { project: () => { routingProjectCalls += 1; return Promise.resolve([]); }, projectRoute: () => Promise.resolve(undefined) },
    memberships: { customerMembershipHistory: (_tx: TransactionContext, _vendorId: string, ids: readonly string[]) => {
      membershipCalls.push([...ids]);
      return Promise.resolve([{ membershipId: agentMembershipId, userId: agentUserId }]);
    } },
    notifications: { append: (_tx: TransactionContext, notification: { recipientUserId: string }) => {
      notifiedUsers.push(notification.recipientUserId);
      return Promise.resolve();
    } },
    labels: { read: (_tx: TransactionContext, input: { references: readonly SubscriptionLabelReference[] }) => {
      labelCalls.push([...input.references]);
      return Promise.resolve(labelMatches(input.references));
    } },
  });
  (service as unknown as { now: () => Date }).now = () => new Date('2029-12-31T00:00:00.000Z');

  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000095' }, () => service.create(
    actor, vendorId, householdId, { startDate: '2030-01-01', endDate: '2129-12-31', subscriptionIds: [subscriptionId] },
  ));

  assert.equal(previewPageCallsForFullRange, 0);
  assert.equal(deliveryCandidateCount, 2);
  assert.ok(maxCandidatePageSize <= 100);
  assert.equal(routingProjectCalls, 0);
  assert.deepEqual(membershipCalls, [[agentMembershipId]]);
  assert.deepEqual(notifiedUsers.sort(), [actor.userId, agentUserId].sort());
  assert.equal(labelCalls.length, 1);
});

void test('delivery synchronization pages at 100 in cursor order and deduplicates one membership lookup', async () => {
  const candidates = Array.from({ length: 102 }, (_, index) => deliveryCandidate(index + 1, `${2030 + index}-01-01`));
  const cursors: Array<string | undefined> = [];
  const effectiveBatches: string[][] = [];
  const synchronizedBatches: Array<readonly (DeliveryLeaveCandidate & { effective: boolean })[]> = [];
  const membershipCalls: string[][] = [];
  const secondAgentMembershipId = '00000000-0000-4000-8000-000000000017';
  let persisted = false;
  const service = boundedService({
    preview: () => Promise.resolve({ items: [], onTimeCount: 102, lateCount: 0 }),
    lockSubscriptions: () => Promise.resolve(),
    createRevision: () => { persisted = true; return Promise.resolve(request()); },
    effectiveOccurrenceKeys: (_tx: TransactionContext, input: { candidates: readonly DeliveryLeaveCandidate[] }) => {
      effectiveBatches.push(input.candidates.map(({ id }) => id));
      return Promise.resolve(new Set(input.candidates.filter((_, index) => index % 2 === 0).map(deliveryOccurrenceKey)));
    },
  }, {
    listAffected: (_tx: TransactionContext, _vendorId: string, _selections: unknown, query: { cursor?: string; limit: number }) => {
      assert.equal(persisted, true);
      assert.equal(query.limit, 100);
      cursors.push(query.cursor);
      return Promise.resolve(query.cursor
        ? { items: candidates.slice(100) }
        : { items: candidates.slice(0, 100), nextCursor: 'page-2' });
    },
    synchronize: (_tx: TransactionContext, _actor: unknown, states: readonly (DeliveryLeaveCandidate & { effective: boolean })[]) => {
      synchronizedBatches.push(states);
      return Promise.resolve({ agentMembershipIds: states.length === 100
        ? [secondAgentMembershipId, agentMembershipId, secondAgentMembershipId]
        : [agentMembershipId] });
    },
  }, {
    memberships: { customerMembershipHistory: (_tx: TransactionContext, _vendorId: string, ids: readonly string[]) => {
      membershipCalls.push([...ids]);
      return Promise.resolve(ids.map((id) => ({ membershipId: id, userId: id })));
    } },
  });
  (service as unknown as { now: () => Date }).now = () => new Date('2029-12-31T00:00:00.000Z');

  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000094' }, () => service.create(
    actor, vendorId, householdId, { startDate: '2030-01-01', endDate: '2131-12-31', subscriptionIds: [subscriptionId] },
  ));

  assert.deepEqual(cursors, [undefined, 'page-2']);
  assert.deepEqual(effectiveBatches.map(({ length }) => length), [100, 2]);
  assert.deepEqual(synchronizedBatches.map(({ length }) => length), [100, 2]);
  assert.deepEqual(synchronizedBatches.flat().map(({ id }) => id), candidates.map(({ id }) => id));
  assert.equal(synchronizedBatches.every((batch) => batch.length <= 100), true);
  assert.equal(synchronizedBatches.flat().every((item, index) => item.effective === ((index % 100) % 2 === 0)), true);
  assert.deepEqual(membershipCalls, [[agentMembershipId, secondAgentMembershipId]]);
});

void test('empty affected-delivery page skips effective, synchronization, and membership work', async () => {
  const calls: string[] = [];
  const service = boundedService({
    preview: () => Promise.resolve({ items: [], onTimeCount: 1, lateCount: 0 }),
    lockSubscriptions: () => Promise.resolve(),
    createRevision: () => Promise.resolve(request()),
    effectiveOccurrenceKeys: () => { calls.push('effective'); return Promise.resolve(new Set()); },
  }, {
    listAffected: () => { calls.push('list'); return Promise.resolve({ items: [] }); },
    synchronize: () => { calls.push('synchronize'); return Promise.resolve({ agentMembershipIds: [] }); },
  }, {
    memberships: { customerMembershipHistory: () => { calls.push('memberships'); return Promise.resolve([]); } },
  });
  (service as unknown as { now: () => Date }).now = () => new Date('2029-12-31T00:00:00.000Z');

  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000093' }, () => service.create(
    actor, vendorId, householdId, { startDate: '2030-01-01', endDate: '2030-01-02', subscriptionIds: [subscriptionId] },
  ));
  assert.deepEqual(calls, ['list']);
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
    { append: () => Promise.resolve() }, { listAffected: () => Promise.resolve({ items: [] }), synchronize: () => Promise.resolve({ agentMembershipIds: [] }),
      applyCustomerLeave: () => Promise.resolve(), reverseCustomerLeave: () => Promise.resolve() },
    { append: () => Promise.resolve() }, { project: () => Promise.resolve([]), projectRoute: () => Promise.resolve(undefined) },
    { customerMembershipHistory: () => Promise.resolve([]) } as never,
    { read: (_tx: TransactionContext, input: { references: readonly SubscriptionLabelReference[] }) => Promise.resolve(labelMatches(input.references)) },
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

void test('direct service results derive exact audience actions and stable timeline labels', async () => {
  const productId = '00000000-0000-4000-8000-000000000030';
  const secondSubscriptionId = '00000000-0000-4000-8000-000000000031';
  const secondSlotId = '00000000-0000-4000-8000-000000000032';
  const currentRevisionId = '00000000-0000-4000-8000-000000000041';
  const historicalRevisionId = '00000000-0000-4000-8000-000000000040';
  const pendingId = '00000000-0000-4000-8000-000000000050';
  const approvedId = '00000000-0000-4000-8000-000000000051';
  const historicalPendingId = '00000000-0000-4000-8000-000000000052';
  const rejectedId = '00000000-0000-4000-8000-000000000053';
  const cutoffAt = new Date('2030-01-01T00:30:00.000Z');
  const base = requestWith({
    status: 'accepted', currentRevisionId,
    revisions: [
      revisionWith({ id: historicalRevisionId, createdAt: new Date('2030-01-01T00:00:00.000Z'), decisions: [
        decisionWith({ id: historicalPendingId, status: 'pending', subscriptionId: secondSubscriptionId, deliverySlotId: secondSlotId, serviceDate: '2030-01-01', cutoffAt }),
      ] }),
      revisionWith({ id: currentRevisionId, createdAt: new Date('2030-01-01T00:00:00.000Z'), subscriptionIds: [secondSubscriptionId, subscriptionId], decisions: [
        decisionWith({ id: approvedId, status: 'approved', subscriptionId: secondSubscriptionId, deliverySlotId: secondSlotId, serviceDate: '2030-01-02', cutoffAt }),
        decisionWith({ id: pendingId, status: 'pending', serviceDate: '2030-01-02', cutoffAt }),
        decisionWith({ id: rejectedId, status: 'rejected', serviceDate: '2030-01-04', cutoffAt }),
      ] }),
    ],
  });
  const labelCalls: Array<{ householdId?: string; references: readonly { referenceId: string }[] }> = [];
  const labels = { read: (_tx: TransactionContext, input: { householdId?: string; references: readonly SubscriptionLabelReference[] }) => {
    labelCalls.push(input);
    return Promise.resolve(input.references.flatMap((reference) => {
      const id = reference.subscriptionId;
      const slot = reference.kind === 'occurrence' ? reference.deliverySlotId : id === secondSubscriptionId ? secondSlotId : slotId;
      return [
        { referenceId: reference.referenceId, subscriptionId: id, productId, productName: 'Milk', deliverySlotId: slot, deliverySlotName: 'Morning' },
        { referenceId: reference.referenceId, subscriptionId: id, productId, productName: 'Milk', deliverySlotId: slot, deliverySlotName: 'Morning' },
        { referenceId: reference.referenceId, subscriptionId: '00000000-0000-4000-8000-000000000099', productId, productName: 'Foreign', deliverySlotId: slot, deliverySlotName: 'Night' },
      ];
    }));
  } };
  let customerRecord = base;
  let vendorRecord = base;
  const service = directService({
    getRequest: () => Promise.resolve(customerRecord),
    getVendorRequest: () => Promise.resolve(vendorRecord),
  }, labels);

  for (const status of ['pending_approval', 'partially_pending', 'accepted', 'rejected'] as const) {
    customerRecord = { ...base, status };
    assert.deepEqual((await service.getCustomer(actor, vendorId, householdId, base.id)).availableActions, ['amend', 'cancel']);
  }
  customerRecord = { ...base, status: 'cancelled' };
  assert.deepEqual((await service.getCustomer(actor, vendorId, householdId, base.id)).availableActions, []);
  const noCurrent = requestWith({ ...base, currentRevisionId: undefined });
  customerRecord = noCurrent;
  assert.deepEqual((await service.getCustomer(actor, vendorId, householdId, base.id)).availableActions, []);
  customerRecord = { ...base, currentRevisionId: '00000000-0000-4000-8000-000000000098' };
  assert.deepEqual((await service.getCustomer(actor, vendorId, householdId, base.id)).availableActions, []);

  customerRecord = base;
  const customer = await service.getCustomer(actor, vendorId, householdId, base.id);
  const customerDecision = customer.revisions[0]?.decisions?.[0];
  assert.ok(customerDecision);
  assert.equal('availableActions' in customerDecision, false);
  assert.deepEqual(customer.revisions[0]?.subscriptionLabels, [
    { subscriptionId, productId, productName: 'Milk', deliverySlotId: slotId, deliverySlotName: 'Morning' },
    { subscriptionId: secondSubscriptionId, productId, productName: 'Milk', deliverySlotId: secondSlotId, deliverySlotName: 'Morning' },
  ]);
  const vendor = await service.getVendorRequest(actor, vendorId, base.id);
  assert.equal('availableActions' in vendor, false);
  assert.deepEqual(vendor.revisions.map(({ id }) => id), [currentRevisionId, historicalRevisionId]);
  assert.deepEqual(vendor.revisions[0]?.decisions?.map(({ id }) => id), [pendingId, approvedId, rejectedId]);
  assert.deepEqual(vendor.revisions[0]?.decisions?.map(({ availableActions }) => availableActions), [['approve', 'reject'], [], []]);
  assert.deepEqual(vendor.revisions[1]?.decisions?.map(({ availableActions }) => availableActions), [[]]);
  assert.equal(vendor.revisions[0]?.decisions?.[0]?.cutoffAt, cutoffAt);
  assert.equal(vendor.revisions[0]?.decisions?.[0]?.source, 'customer');
  vendorRecord = noCurrent;
  assert.equal((await service.getVendorRequest(actor, vendorId, base.id)).revisions.flatMap(({ decisions }) => decisions ?? []).every(({ availableActions }) => availableActions.length === 0), true);
  assert.equal(labelCalls.length, 10);
  assert.equal(labelCalls.every(({ householdId: scope }) => scope === householdId || scope === undefined), true);
});

void test('approve and reject retain finalized decision timelines with one label batch', async () => {
  const decisionId = '00000000-0000-4000-8000-000000000060';
  const revisionId = '00000000-0000-4000-8000-000000000061';
  const productId = '00000000-0000-4000-8000-000000000062';
  const cutoffAt = new Date('2030-01-01T00:30:00.000Z');
  const labelCalls: SubscriptionLabelReference[][] = [];
  let decision: 'approved' | 'rejected' = 'approved';
  const service = directService({
    decide: () => {
      const finalized = decisionWith({ id: decisionId, status: decision, cutoffAt, source: 'system' });
      const leave = requestWith({
        currentRevisionId: revisionId,
        revisions: [revisionWith({ id: revisionId, source: 'system', decisions: [finalized] })],
      });
      return Promise.resolve({ ...finalized, vendorId, leaveRequestRevisionId: revisionId, source: 'system', request: leave });
    },
    isEffectivelyOnLeave: () => Promise.resolve(decision === 'approved'),
  }, { read: (_tx: TransactionContext, input: { references: readonly SubscriptionLabelReference[] }) => {
    labelCalls.push([...input.references]);
    return Promise.resolve(input.references.map((reference) => ({
      referenceId: reference.referenceId, subscriptionId: reference.subscriptionId, productId, productName: 'Preserved Milk',
      deliverySlotId: reference.kind === 'occurrence' ? reference.deliverySlotId : slotId, deliverySlotName: 'Preserved Morning',
    })));
  } });

  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000096' }, async () => {
    for (const next of ['approved', 'rejected'] as const) {
      decision = next;
      const result = await service.decideOccurrence(actor, vendorId, decisionId, { expectedVersion: 1, decision: next, reason: ' reviewed ' });
      assert.equal(result.id, decisionId);
      assert.equal(result.leaveRequestRevisionId, revisionId);
      assert.equal(result.cutoffAt, cutoffAt);
      assert.equal(result.source, 'system');
      assert.equal(result.productId, productId);
      assert.equal(result.productName, 'Preserved Milk');
      assert.equal(result.deliverySlotName, 'Preserved Morning');
      assert.equal(result.currentStatus, next);
      assert.equal(result.request.id, request().id);
      assert.equal(result.request.currentRevisionId, revisionId);
      assert.deepEqual(result.request.revisions[0]?.subscriptionLabels, [{
        subscriptionId, productId, productName: 'Preserved Milk', deliverySlotId: slotId, deliverySlotName: 'Preserved Morning',
      }]);
      const timeline = result.request.revisions[0]?.decisions?.[0];
      assert.equal(timeline?.id, decisionId);
      assert.equal(timeline?.cutoffAt, cutoffAt);
      assert.equal(timeline?.source, 'system');
      assert.equal(timeline?.productId, productId);
      assert.equal(timeline?.productName, 'Preserved Milk');
      assert.equal(timeline?.deliverySlotName, 'Preserved Morning');
      assert.deepEqual(timeline?.availableActions, []);
      assert.equal(labelCalls.length, next === 'approved' ? 1 : 2);
    }
  });
});

void test('each page and preview batches labels once and empty results short-circuit', async () => {
  const calls: Array<readonly { referenceId: string }[]> = [];
  const record = requestWith({ currentRevisionId: request().revisions[0].id });
  const decision = decisionWith({ id: '00000000-0000-4000-8000-000000000060', status: 'pending', cutoffAt: new Date('2030-01-01T00:00:00.000Z') });
  let empty = false;
  const service = directService({
    preview: () => Promise.resolve({ items: empty ? [] : [{ subscriptionId, deliverySlotId: slotId, serviceDate: '2030-01-02', cutoffAt: decision.cutoffAt, timing: 'late', proposedBehavior: 'pending_approval' }], onTimeCount: 0, lateCount: empty ? 0 : 1 }),
    assertNoOverlap: () => Promise.resolve(),
    listRequests: () => Promise.resolve({ items: empty ? [] : [record, record] }),
    listPendingDecisions: () => Promise.resolve({ items: empty ? [] : [{ ...decision, vendorId, leaveRequestRevisionId: record.revisions[0].id }, { ...decision, id: '00000000-0000-4000-8000-000000000061', vendorId, leaveRequestRevisionId: record.revisions[0].id }] }),
  }, { read: (_tx: TransactionContext, input: { references: readonly SubscriptionLabelReference[] }) => {
    calls.push(input.references);
    return Promise.resolve(input.references.map((reference) => ({
      referenceId: reference.referenceId, subscriptionId: reference.subscriptionId, productId: '00000000-0000-4000-8000-000000000070', productName: 'Milk',
      deliverySlotId: reference.kind === 'occurrence' ? reference.deliverySlotId : slotId, deliverySlotName: 'Morning',
    })));
  } });

  const preview = await service.preview(actor, vendorId, householdId, { startDate: '2030-01-02', endDate: '2030-01-02', subscriptionIds: [subscriptionId] });
  assert.equal(preview.items[0]?.productName, 'Milk');
  assert.equal((await service.listCustomer(actor, vendorId, householdId, {})).items.length, 2);
  assert.equal((await service.listDecisions(actor, vendorId, {})).items[0]?.source, 'customer');
  assert.equal(calls.length, 3);

  empty = true;
  await service.preview(actor, vendorId, householdId, { startDate: '2030-01-02', endDate: '2030-01-02', subscriptionIds: [subscriptionId] });
  await service.listCustomer(actor, vendorId, householdId, {});
  await service.listDecisions(actor, vendorId, {});
  assert.equal(calls.length, 3);
});

function request(): LeaveRequestRecord {
  return {
    id: '00000000-0000-4000-8000-000000000020', vendorId, householdId, status: 'accepted' as const, version: 1,
    createdAt: new Date('2030-01-01T00:00:00.000Z'), updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    revisions: [{ id: '00000000-0000-4000-8000-000000000021', action: 'create' as const, startDate: '2030-01-02', endDate: '2030-01-03', source: 'customer' as const, createdBy: actor.userId, status: 'accepted' as const, createdAt: new Date('2030-01-01T00:00:00.000Z'), subscriptions: [{ subscriptionId, selected: true }], subscriptionIds: [subscriptionId] }],
  };
}

function decisionWith(values: Partial<LeaveRevisionDecisionRecord> = {}): LeaveRevisionDecisionRecord {
  return {
    id: values.id ?? '00000000-0000-4000-8000-000000000080', subscriptionId: values.subscriptionId ?? subscriptionId,
    serviceDate: values.serviceDate ?? '2030-01-02', deliverySlotId: values.deliverySlotId ?? slotId, status: values.status ?? 'pending',
    previousEffectiveStatus: 'scheduled' as const, requestedEffectiveStatus: 'skipped_by_customer' as const,
    cutoffAt: values.cutoffAt ?? new Date('2030-01-01T00:00:00.000Z'), source: values.source ?? 'customer',
    version: 1, createdAt: new Date('2030-01-01T00:00:00.000Z'),
  };
}

function revisionWith(values: Partial<LeaveRevisionRecord> = {}): LeaveRevisionRecord {
  return { ...request().revisions[0], ...values, decisions: values.decisions ?? [] };
}

function requestWith(values: Partial<LeaveRequestRecord> = {}): LeaveRequestRecord {
  return { ...request(), ...values, revisions: values.revisions ?? request().revisions };
}

function directService(store: Record<string, unknown>, labels: Record<string, unknown>) {
  return new DefaultLeaveService(
    { execute: (_input: unknown, operation: (current: TransactionContext) => Promise<unknown>) => operation(tx) } as never,
    { requireCustomerSubscriptionHousehold: () => Promise.resolve({ householdId }) } as never,
    store as never,
    { getDeliveryPolicyForTransaction: () => Promise.resolve({ vendorId, skipCutoffMinutes: 60, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, version: 1 }), getSubscriptionTimezone: () => Promise.resolve({ timezone: 'UTC' }) } as never,
    { append: () => Promise.resolve() },
    { applyCustomerLeave: () => Promise.resolve(), reverseCustomerLeave: () => Promise.resolve() } as never,
    { append: () => Promise.resolve() },
    { project: () => Promise.resolve([]), projectRoute: () => Promise.resolve(undefined) },
    { customerMembershipHistory: () => Promise.resolve([]) } as never,
    labels as never,
  );
}

function boundedService(
  store: Record<string, unknown>,
  deliveries: Record<string, unknown>,
  overrides: Readonly<{
    notifications?: Record<string, unknown>;
    routing?: Record<string, unknown>;
    memberships?: Record<string, unknown>;
    labels?: Record<string, unknown>;
  }> = {},
) {
  return new DefaultLeaveService(
    { execute: (_input: unknown, operation: (current: TransactionContext) => Promise<unknown>) => operation(tx) } as never,
    { requireCustomerSubscriptionHousehold: () => Promise.resolve({ householdId }) } as never,
    store as never,
    { getDeliveryPolicyForTransaction: () => Promise.resolve({ vendorId, skipCutoffMinutes: 60, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, version: 1 }), getSubscriptionTimezone: () => Promise.resolve({ timezone: 'UTC' }) } as never,
    { append: () => Promise.resolve() },
    deliveries as never,
    (overrides.notifications ?? { append: () => Promise.resolve() }) as never,
    (overrides.routing ?? { project: () => Promise.resolve([]), projectRoute: () => Promise.resolve(undefined) }) as never,
    (overrides.memberships ?? { customerMembershipHistory: () => Promise.resolve([]) }) as never,
    (overrides.labels ?? { read: (_tx: TransactionContext, input: { references: readonly SubscriptionLabelReference[] }) => Promise.resolve(labelMatches(input.references)) }) as never,
  );
}

function deliveryCandidate(index: number, serviceDate: string): DeliveryLeaveCandidate {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    vendorId, subscriptionId, deliverySlotId: slotId, serviceDate, version: 1,
  };
}

function deliveryOccurrenceKey(value: Pick<DeliveryLeaveCandidate, 'subscriptionId' | 'serviceDate' | 'deliverySlotId'>) {
  return `${value.serviceDate}:${value.subscriptionId}:${value.deliverySlotId}`;
}

function labelMatches(references: readonly SubscriptionLabelReference[]) {
  return references.map((reference) => ({
    referenceId: reference.referenceId, subscriptionId: reference.subscriptionId,
    productId: '00000000-0000-4000-8000-000000000090', productName: 'Milk',
    deliverySlotId: reference.kind === 'occurrence' ? reference.deliverySlotId : slotId, deliverySlotName: 'Morning',
  }));
}
