import assert from 'node:assert/strict';
import test from 'node:test';

import type { Actor } from '../src/common/context/request-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { RouteController } from '../src/routing/http/route.controller.js';

const actor: Actor = { userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', displayName: 'Owner', authenticationMethod: 'administrator_mfa', platformRoles: [], memberships: [] };

void test('route controller maps an explicit public response and lifecycle status codes', async () => {
  const at = new Date('2026-07-20T10:00:00Z');
  const route = { id: '00000000-0000-4000-8000-000000000010', vendorId: '00000000-0000-4000-8000-000000000020', code: 'MORNING', name: 'Morning', deliverySlotId: '00000000-0000-4000-8000-000000000030', status: 'active' as const, version: 1, createdAt: at, updatedAt: at };
  const controller = new RouteController({ create: () => Promise.resolve(route) } as never);
  const response = await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000040', actor }, () => controller.create(route.vendorId, { code: 'morning', name: ' Morning ', deliverySlotId: route.deliverySlotId }));
  assert.deepEqual(response, { ...route, createdAt: at.toISOString(), updatedAt: at.toISOString() });
  for (const method of ['deactivate', 'reactivate', 'restore']) {
    const handler = Object.getOwnPropertyDescriptor(RouteController.prototype, method)?.value as object;
    assert.equal(Reflect.getMetadata('__httpCode__', handler), 200);
  }
});
