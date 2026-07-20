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
  routeAssignmentId: '00000000-0000-4000-8000-000000000016',
  routeStopId: '00000000-0000-4000-8000-000000000017',
  serviceDate: '2026-07-20',
  plannedQuantity: '1.25',
  sequence: 1,
};

void test('agent scheduled-delivery controller whitelists response fields and page metadata', async () => {
  const controller = new AgentScheduledDeliveryController({
    listSelf: () => Promise.resolve({
      items: [{ ...delivery, internalNote: 'must not cross HTTP boundary' }],
      nextCursor: 'next',
      internalPageState: 'must not cross HTTP boundary',
    }),
  });

  const response = await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000003', actor },
    () => controller.list('00000000-0000-4000-8000-000000000004', { serviceDate: delivery.serviceDate }),
  );

  assert.deepEqual(response, { items: [delivery], nextCursor: 'next' });
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
