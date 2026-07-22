import assert from 'node:assert/strict';
import test from 'node:test';

import type { Actor } from '../src/common/context/request-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import { AgentScheduledDeliveryController } from '../src/scheduling/http/scheduled-delivery.controller.js';
import { PrismaScheduledDeliveryStore } from '../src/scheduling/infrastructure/prisma-scheduled-delivery.store.js';

const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Agent',
  authenticationMethod: 'phone_otp',
  platformRoles: [],
  memberships: [],
};

const delivery = {
  id: '00000000-0000-4000-8000-000000000010',
  subscriptionId: '00000000-0000-4000-8000-000000000011',
  householdId: '00000000-0000-4000-8000-000000000012',
  productId: '00000000-0000-4000-8000-000000000013',
  unitId: '00000000-0000-4000-8000-000000000014',
  deliverySlotId: '00000000-0000-4000-8000-000000000015',
  deliverySlotName: 'Morning',
  deliverySlotStartLocalTime: '06:00',
  deliverySlotEndLocalTime: '09:00',
  routeAssignmentId: '00000000-0000-4000-8000-000000000016',
  routeStopId: '00000000-0000-4000-8000-000000000017',
  routeId: '00000000-0000-4000-8000-000000000018',
  routeCode: 'R-01',
  routeName: 'North route',
  householdAccountNumber: 'H-001',
  householdName: 'Patel Home',
  addressLine1: '12 Lake Road',
  addressLine2: 'Floor 2',
  locality: 'Camp',
  city: 'Pune',
  region: 'MH',
  postalCode: '411001',
  countryCode: 'IN',
  productCode: 'MILK',
  productName: 'Full cream milk',
  unitCode: 'L',
  unitName: 'Litre',
  serviceDate: '2026-07-20',
  plannedQuantity: '1.25',
  sequence: 1,
  currentStatus: 'scheduled' as const,
  version: 3,
  blockedByCustomerLeave: false,
  captureLocationEvidence: true,
  pendingStopItems: [{
    scheduledDeliveryId: '00000000-0000-4000-8000-000000000010',
    expectedVersion: 3,
    plannedQuantity: '1.25',
    productName: 'Full cream milk',
    unitName: 'Litre',
  }],
};

void test('agent scheduled-delivery controller whitelists response fields and page metadata', async () => {
  const controller = new AgentScheduledDeliveryController({
    listSelf: () => Promise.resolve({
      serviceDate: delivery.serviceDate,
      items: [{
        ...delivery,
        customerPhone: '+919999999999',
        householdNotes: 'must not cross HTTP boundary',
        priceSourceId: 'must not cross HTTP boundary',
        amountMinor: '100',
        latitude: '18.5',
        longitude: '73.8',
        billingStatus: 'unbilled',
        internalNote: 'must not cross HTTP boundary',
        pendingStopItems: [{
          ...delivery.pendingStopItems[0],
          amountMinor: '100',
          latitude: '18.5',
          customerPhone: '+919999999999',
          note: 'must not cross HTTP boundary',
        }],
      }],
      nextCursor: 'next',
      internalPageState: 'must not cross HTTP boundary',
    }),
  });

  const response = await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000003', actor },
    () => controller.list('00000000-0000-4000-8000-000000000004', {}),
  );

  assert.deepEqual(response, { serviceDate: delivery.serviceDate, items: [delivery], nextCursor: 'next' });
  assert.deepEqual(Object.keys(response.items[0]).sort(), Object.keys(delivery).sort());
  assert.deepEqual(Object.keys(response.items[0].pendingStopItems[0]).sort(), [
    'expectedVersion', 'plannedQuantity', 'productName', 'scheduledDeliveryId', 'unitName',
  ]);
});

void test('scheduled-delivery query returns finalized leave rows and a complete pending stop set beyond the outer page', async () => {
  let sql = '';
  const leave = {
    ...delivery,
    currentStatus: 'skipped_by_customer' as const,
    blockedByCustomerLeave: true,
    version: 4,
  };
  const sibling = {
    ...delivery,
    id: '00000000-0000-4000-8000-000000000020',
    productName: 'Toned milk',
    version: 5,
  };
  const pendingStopItems = [sibling]
    .map(({ id, version, plannedQuantity, productName, unitName }) => ({
      scheduledDeliveryId: id, expectedVersion: version, plannedQuantity, productName, unitName,
    }));
  const transaction = wrapPrismaTransaction({
    $queryRaw: (query: Readonly<{ strings: readonly string[] }>) => {
      sql = query.strings.join('?').replaceAll(/\s+/gu, ' ');
      return Promise.resolve([
        { ...leave, pendingStopItems },
        { ...sibling, pendingStopItems },
      ]);
    },
  } as never);

  const page = await new PrismaScheduledDeliveryStore().listSelf(
    transaction,
    '00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000005',
    delivery.serviceDate,
    { limit: 1 },
  );

  assert.deepEqual(page.items.map(({ id }) => id), [leave.id]);
  assert.equal(page.items[0]?.currentStatus, 'skipped_by_customer');
  assert.equal(page.items[0]?.blockedByCustomerLeave, true);
  assert.deepEqual(page.items[0]?.pendingStopItems, pendingStopItems);
  assert.ok(page.nextCursor);
  assert.match(sql, /d\.status AS "currentStatus"/u);
  assert.match(sql, /d\.version/u);
  assert.match(sql, /capture_agent_location_evidence/u);
  assert.match(sql, /jsonb_agg/u);
  assert.match(sql, /pendingStopItems/u);
  assert.match(sql, /d\.status='scheduled' AND d\.finalized_at IS NULL/u);
  assert.match(sql, /pending\."pendingEligible"/u);
  assert.match(sql, /ORDER BY pending\.id/u);
  assert.match(sql, /d\.status IN \('scheduled','delivered','skipped_by_customer','skipped_by_agent','missed'\)/u);
});

for (const sequence of [0, -1]) {
  void test(`agent scheduled-delivery cursor rejects sequence ${sequence}`, async () => {
    const transaction = wrapPrismaTransaction({ $queryRaw: () => Promise.resolve([]) } as never);
    const cursor = Buffer.from(JSON.stringify([
      sequence,
      '00000000-0000-4000-8000-000000000010',
    ])).toString('base64url');

    await assert.rejects(
      new PrismaScheduledDeliveryStore().listSelf(
        transaction,
        '00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000005',
        delivery.serviceDate,
        { cursor },
      ),
      (cause: unknown) => cause instanceof Error && 'code' in cause && cause.code === 'INVALID_CURSOR',
    );
  });
}
