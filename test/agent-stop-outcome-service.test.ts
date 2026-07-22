import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { Actor } from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import { DefaultAgentStopOutcomeService } from '../src/delivery/application/agent-stop-outcome.service.js';

const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Agent', authenticationMethod: 'phone_otp', platformRoles: [], memberships: [],
};
const vendorId = '00000000-0000-4000-8000-000000000003';
const routeStopId = '00000000-0000-4000-8000-000000000004';
const tx = {} as TransactionContext;
const ids = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000010'] as const;
const pending = ids.map((id, index) => ({
  id, vendorId, subscriptionId: `00000000-0000-4000-8000-00000000002${index}`,
  householdId: `00000000-0000-4000-8000-00000000003${index}`,
  productId: `00000000-0000-4000-8000-00000000004${index}`,
  unitId: `00000000-0000-4000-8000-00000000005${index}`,
  deliverySlotId: '00000000-0000-4000-8000-000000000060',
  routeAssignmentId: '00000000-0000-4000-8000-000000000070',
  serviceDate: '2030-01-01', plannedQuantity: '1', currentStatus: 'scheduled' as const, version: index + 1,
})).sort((left, right) => left.id.localeCompare(right.id));

function fixture(overrides: Readonly<{
  onLeave?: (id: string) => boolean;
  missingPriceId?: string;
  captureLocation?: boolean;
  agentError?: ApplicationError;
  lockError?: ApplicationError;
}> = {}) {
  const calls: Array<{ kind: string; value?: unknown }> = [];
  const authorization = {
    execute: (input: unknown, work: (current: TransactionContext) => Promise<unknown>) => {
      calls.push({ kind: 'authorize', value: input }); return work(tx);
    },
  };
  const store = {
    lockStopPendingSet: (_tx: TransactionContext, input: { submitted: readonly { scheduledDeliveryId: string }[] }) => {
      calls.push({ kind: 'lock', value: input.submitted.map(({ scheduledDeliveryId }) => scheduledDeliveryId) });
      if (overrides.lockError) return Promise.reject(overrides.lockError);
      return Promise.resolve(pending);
    },
    createPriceSnapshot: (_tx: TransactionContext, value: unknown) => { calls.push({ kind: 'snapshot', value }); return Promise.resolve(); },
    appendFinalOutcome: (_tx: TransactionContext, value: { scheduledDeliveryId: string; outcome: string; actualQuantity?: string }) => {
      calls.push({ kind: 'event', value });
      const source = pending.find(({ id }) => id === value.scheduledDeliveryId)!;
      return Promise.resolve({ ...source, currentStatus: value.outcome, version: source.version + 1, ...(value.actualQuantity ? { actualQuantity: value.actualQuantity } : {}), finalizedAt: new Date() });
    },
  };
  const service = new DefaultAgentStopOutcomeService(
    authorization as never,
    { resolveSelfRouteAgent: () => {
      calls.push({ kind: 'agent' });
      return overrides.agentError ? Promise.reject(overrides.agentError) : Promise.resolve({ membershipId: 'agent-membership' });
    } } as never,
    store as never,
    { isEffectivelyOnLeave: (_tx: TransactionContext, key: { subscriptionId: string }) => { calls.push({ kind: 'leave', value: key.subscriptionId }); return Promise.resolve(overrides.onLeave?.(key.subscriptionId) ?? false); } },
    { resolve: (_tx: TransactionContext, _vendorId: string, value: { productId: string }) => { calls.push({ kind: 'price', value: value.productId }); return Promise.resolve(value.productId === overrides.missingPriceId ? undefined : { amountMinor: '100', currency: 'INR', pricingLevel: 'global', sourcePriceId: value.productId, sourcePriceType: 'global_price', resolvedAt: new Date('2030-01-01T00:30:00Z') }); } } as never,
    { getDeliveryPolicyForTransaction: () => Promise.resolve({ captureAgentLocationEvidence: overrides.captureLocation ?? false }) } as never,
    { getNotificationRecipientUserIds: () => Promise.resolve(new Map(pending.map(({ householdId }, index) => [householdId, [`00000000-0000-4000-8000-00000000008${index}`]]))) } as never,
    { append: (_tx: TransactionContext, value: unknown) => { calls.push({ kind: 'notification', value }); return Promise.resolve(); } },
  );
  return { service, calls };
}

const items = pending.map(({ id, version }, index) => ({ scheduledDeliveryId: id, expectedVersion: version, actualQuantity: `${index + 1}.500` }));
const nonDeliveredItems = items.map(({ scheduledDeliveryId, expectedVersion }) => ({ scheduledDeliveryId, expectedVersion }));

void test('delivered locks sorted IDs, checks leave and all prices, then snapshots and finalizes atomically', async () => {
  const { service, calls } = fixture();
  const result = await service.record(actor, vendorId, routeStopId, {
    serviceDate: '2030-01-01', outcome: 'delivered', occurredAt: '2030-01-01T06:30:00+05:30', items: [...items].reverse(),
  });
  assert.deepEqual(calls.find(({ kind }) => kind === 'authorize')?.value, {
    actor, vendorId, permission: 'delivery:record', operation: 'delivery.stop-outcome',
  });
  assert.deepEqual((calls.find(({ kind }) => kind === 'lock')?.value), [...ids].sort());
  assert.equal(calls.filter(({ kind }) => kind === 'leave').length, 2);
  assert.equal(calls.filter(({ kind }) => kind === 'price').length, 2);
  assert.equal(calls.filter(({ kind }) => kind === 'snapshot').length, 2);
  assert.equal(calls.filter(({ kind }) => kind === 'event').length, 2);
  assert.equal(calls.filter(({ kind }) => kind === 'notification').length, 0);
  assert.deepEqual(result.items.map(({ currentStatus }) => currentStatus), ['delivered', 'delivered']);
  assert.equal(result.routeStopId, routeStopId);
});

void test('missing price or effective leave rejects before any write', async () => {
  for (const options of [
    { missingPriceId: pending[1].productId },
    { onLeave: (id: string) => id === pending[1].subscriptionId },
  ]) {
    const { service, calls } = fixture(options);
    await assert.rejects(
      service.record(actor, vendorId, routeStopId, { serviceDate: '2030-01-01', outcome: 'delivered', occurredAt: '2030-01-01T01:00:00Z', items }),
      (error: unknown) => error instanceof ApplicationError && ['DELIVERY_PRICE_NOT_FOUND', 'CUSTOMER_LEAVE_EFFECTIVE'].includes(error.code),
    );
    assert.equal(calls.some(({ kind }) => ['snapshot', 'event', 'notification'].includes(kind)), false);
  }
});

void test('agent skip accepts every reason, optional GPS, and notifies each active customer', async () => {
  for (const reasonCode of ['customer_on_leave', 'customer_unavailable', 'customer_requested_skip_at_door', 'other'] as const) {
    const { service, calls } = fixture({ captureLocation: true });
    await service.record(actor, vendorId, routeStopId, {
      serviceDate: '2030-01-01', outcome: 'skipped_by_agent', occurredAt: '2030-01-01T01:00:00Z',
      items: nonDeliveredItems, reasonCode,
      ...(reasonCode === 'other' ? { note: 'Customer confirmed leave' } : {}), latitude: 18.52, longitude: 73.85,
    });
    assert.equal(calls.filter(({ kind }) => kind === 'notification').length, 2);
    assert.deepEqual(
      calls.filter(({ kind }) => kind === 'notification').map(({ value }) => (value as { householdId: string }).householdId).sort(),
      pending.map(({ householdId }) => householdId).sort(),
    );
  }
});

void test('business validation rejects invalid union fields inside the transaction', async () => {
  const cases = [
    { serviceDate: '2030-01-01', outcome: 'delivered', occurredAt: '2030-01-01', items },
    { serviceDate: '2030-01-01', outcome: 'delivered', occurredAt: '2030-01-01T01:00:00Z', items, latitude: 1, longitude: 1 },
    { serviceDate: '2030-01-01', outcome: 'missed', occurredAt: '2030-01-01T01:00:00Z', items: nonDeliveredItems, reasonCode: 'other' },
    { serviceDate: '2030-01-01', outcome: 'missed', occurredAt: '2030-01-01T01:00:00Z', items: nonDeliveredItems, reasonCode: 'access_blocked', latitude: 91, longitude: 1 },
    { serviceDate: '2030-01-01', outcome: 'missed', occurredAt: '2030-01-01T01:00:00Z', items: nonDeliveredItems, reasonCode: 'access_blocked', latitude: 1 },
  ] as never[];
  for (const command of cases) {
    const { service, calls } = fixture();
    await assert.rejects(service.record(actor, vendorId, routeStopId, command), ApplicationError);
    assert.equal(calls.some(({ kind }) => kind === 'lock'), false);
  }
});

void test('duplicate delivery IDs are rejected before store access', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.record(actor, vendorId, routeStopId, {
    serviceDate: '2030-01-01', outcome: 'delivered', occurredAt: '2030-01-01T01:00:00Z', items: [items[0], items[0]],
  }), (error: unknown) => error instanceof ApplicationError && error.code === 'INCOMPLETE_STOP_SET');
  assert.equal(calls.some(({ kind }) => kind === 'lock'), false);
});

void test('inactive and wrong agents fail before stop access', async () => {
  for (const name of ['inactive agent', 'wrong vendor agent']) {
    const denial = new ApplicationError('FORBIDDEN', name, 403);
    const { service, calls } = fixture({ agentError: denial });
    await assert.rejects(service.record(actor, vendorId, routeStopId, {
      serviceDate: '2030-01-01', outcome: 'delivered', occurredAt: '2030-01-01T01:00:00Z', items,
    }), (error: unknown) => error === denial);
    assert.equal(calls.some(({ kind }) => kind === 'lock'), false);
    assert.equal(calls.some(({ kind }) => ['snapshot', 'event', 'notification'].includes(kind)), false);
  }
});

void test('assignment, date, stop, vendor, and version conflicts fail before writes', async () => {
  for (const [name, code] of [
    ['wrong assignment', 'INCOMPLETE_STOP_SET'],
    ['wrong service date', 'INCOMPLETE_STOP_SET'],
    ['wrong route stop', 'INCOMPLETE_STOP_SET'],
    ['wrong vendor', 'INCOMPLETE_STOP_SET'],
    ['stale second version', 'STALE_VERSION'],
  ] as const) {
    const conflict = new ApplicationError(code, name, 409);
    const { service, calls } = fixture({ lockError: conflict });
    await assert.rejects(service.record(actor, vendorId, routeStopId, {
      serviceDate: '2030-01-01', outcome: 'delivered', occurredAt: '2030-01-01T01:00:00Z', items,
    }), (error: unknown) => error === conflict);
    assert.equal(calls.some(({ kind }) => ['snapshot', 'event', 'notification'].includes(kind)), false);
  }
});
