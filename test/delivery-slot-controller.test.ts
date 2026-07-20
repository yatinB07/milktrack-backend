import assert from 'node:assert/strict';
import test from 'node:test';

import type { CatalogService } from '../src/catalog/application/catalog.service.js';
import { DeliverySlotController } from '../src/catalog/http/delivery-slot.controller.js';
import { requestContextStore, type Actor } from '../src/common/context/request-context.js';

const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Catalog administrator',
  authenticationMethod: 'administrator_mfa',
  platformRoles: [], memberships: [],
};

void test('delivery-slot controller maps explicit local-time and date response fields', async () => {
  const createdAt = new Date('2026-07-20T10:00:00.000Z');
  const slot = {
    id: '00000000-0000-4000-8000-000000000010',
    vendorId: '00000000-0000-4000-8000-000000000020',
    code: 'MORNING', name: 'Morning', startLocalTime: '06:00', endLocalTime: '09:00',
    status: 'active' as const, createdAt, updatedAt: createdAt,
  };
  const service = { createDeliverySlot: () => Promise.resolve(slot) } as unknown as CatalogService;
  const response = await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000030', actor },
    () => new DeliverySlotController(service).create(slot.vendorId, {
      code: 'morning', name: ' Morning ', startLocalTime: '06:00', endLocalTime: '09:00',
    }),
  );
  assert.deepEqual(response, {
    ...slot, createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(),
  });
});

void test('delivery-slot lifecycle POST actions explicitly return HTTP 200', () => {
  for (const method of ['deactivate', 'reactivate']) {
    const handler = Object.getOwnPropertyDescriptor(DeliverySlotController.prototype, method)?.value as object;
    assert.equal(Reflect.getMetadata('__httpCode__', handler), 200);
  }
});
