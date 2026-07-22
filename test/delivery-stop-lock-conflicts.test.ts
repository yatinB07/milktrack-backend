import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError } from '../src/common/errors/application.error.js';
import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import { PrismaDeliveryStore } from '../src/delivery/infrastructure/prisma-delivery.store.js';

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
