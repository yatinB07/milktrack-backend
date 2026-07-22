import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError } from '../src/common/errors/application.error.js';
import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import { PrismaDeliveryStore } from '../src/delivery/infrastructure/prisma-delivery.store.js';
import { PrismaMembershipStore } from '../src/memberships/infrastructure/prisma-membership.store.js';

const base = {
  vendorId: '00000000-0000-4000-8000-000000000001',
  subscriptionId: '00000000-0000-4000-8000-000000000002',
  householdId: '00000000-0000-4000-8000-000000000003',
  productId: '00000000-0000-4000-8000-000000000004',
  unitId: '00000000-0000-4000-8000-000000000005',
  deliverySlotId: '00000000-0000-4000-8000-000000000006',
  routeAssignmentId: '00000000-0000-4000-8000-000000000007',
  serviceDate: '2030-01-01',
  plannedQuantity: '1.000',
  version: 2,
  finalizedAt: null,
  createdAt: new Date('2030-01-01T00:00:00Z'),
};
const input = {
  vendorId: base.vendorId,
  agentMembershipId: '00000000-0000-4000-8000-000000000008',
  routeStopId: '00000000-0000-4000-8000-000000000009',
  serviceDate: base.serviceDate,
};

function transaction(rows: readonly object[], queries: unknown[]) {
  return wrapPrismaTransaction({
    $queryRaw: (query: unknown) => {
      queries.push(query);
      return Promise.resolve(rows);
    },
  } as never);
}

void test('submitted finalized delivery returns the authoritative finalized conflict', async () => {
  const id = '00000000-0000-4000-8000-000000000010';
  const rows = [{ ...base, id, currentStatus: 'missed', finalizedAt: new Date() }];
  await assert.rejects(
    new PrismaDeliveryStore().lockStopPendingSet(transaction(rows, []), {
      ...input,
      submitted: [{ scheduledDeliveryId: id, expectedVersion: 2 }],
    }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === 'DELIVERY_ALREADY_FINALIZED',
  );
});

void test('missing or foreign submitted IDs remain incomplete-stop conflicts', async () => {
  const pendingId = '00000000-0000-4000-8000-000000000010';
  const foreignId = '00000000-0000-4000-8000-000000000011';
  const rows = [{ ...base, id: pendingId, currentStatus: 'scheduled' }];
  for (const submitted of [[], [{ scheduledDeliveryId: foreignId, expectedVersion: 2 }]]) {
    await assert.rejects(
      new PrismaDeliveryStore().lockStopPendingSet(transaction(rows, []), { ...input, submitted }),
      (error: unknown) => error instanceof ApplicationError
        && error.code === 'INCOMPLETE_STOP_SET',
    );
  }
});

void test('stop deliveries are locked in stable ID order before conflict checks', async () => {
  const queries: unknown[] = [];
  await new PrismaDeliveryStore().lockStopPendingSet(transaction([], queries), { ...input, submitted: [] });
  const sql = (queries[0] as { strings: readonly string[] }).strings.join(' ');
  assert.match(sql, /SELECT\s+d\.id/u);
  assert.match(sql, /ORDER BY d\.id FOR UPDATE OF d/u);
});

void test('each submitted version is compared before a stop set is returned', async () => {
  const ids = [
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000011',
  ];
  const rows = ids.map((id) => ({ ...base, id, currentStatus: 'scheduled' }));
  await assert.rejects(
    new PrismaDeliveryStore().lockStopPendingSet(transaction(rows, []), {
      ...input,
      submitted: ids.map((scheduledDeliveryId, index) => ({ scheduledDeliveryId, expectedVersion: index === 1 ? 1 : 2 })),
    }),
    (error: unknown) => error instanceof ApplicationError && error.code === 'STALE_VERSION',
  );
});

void test('stop lock SQL scopes every assignment and stop boundary to the tenant occurrence', async () => {
  const queries: unknown[] = [];
  await new PrismaDeliveryStore().lockStopPendingSet(transaction([], queries), { ...input, submitted: [] });
  const query = queries[0] as { strings: readonly string[]; values: readonly unknown[] };
  const sql = query.strings.join(' ');
  for (const boundary of [
    /a\.vendor_id=d\.vendor_id AND a\.id=d\.route_assignment_id/u,
    /a\.service_date=d\.service_date AND a\.delivery_slot_id=d\.delivery_slot_id/u,
    /a\.agent_membership_id=.*AND a\.status='assigned'/u,
    /p\.vendor_id=d\.vendor_id AND p\.route_id=a\.route_id AND p\.delivery_slot_id=d\.delivery_slot_id/u,
    /s\.vendor_id=d\.vendor_id AND s\.route_id=a\.route_id AND s\.plan_id=p\.id/u,
    /s\.household_id=d\.household_id AND s\.delivery_slot_id=d\.delivery_slot_id/u,
    /d\.vendor_id=[\s\S]*AND d\.service_date=[\s\S]*AND s\.id=/u,
  ]) assert.match(sql, boundary);
  for (const value of [input.agentMembershipId, input.vendorId, input.serviceDate, input.routeStopId]) {
    assert.equal(query.values.includes(value), true);
  }
});

void test('self-agent lookup is tenant and user scoped to one active delivery-agent membership', async () => {
  const userId = '00000000-0000-4000-8000-000000000012';
  const calls: unknown[] = [];
  const context = wrapPrismaTransaction({
    vendorMembership: {
      findFirst: (query: unknown) => { calls.push(query); return Promise.resolve(undefined); },
    },
  } as never);
  await assert.rejects(
    new PrismaMembershipStore().resolveSelfRouteAgent(context, input.vendorId, userId),
    (error: unknown) => error instanceof ApplicationError && error.code === 'FORBIDDEN',
  );
  assert.deepEqual(calls, [{
    where: {
      vendorId: input.vendorId, userId, role: 'delivery_agent', status: 'active', endedAt: null, deletedAt: null,
    },
    select: { id: true },
  }]);
});
