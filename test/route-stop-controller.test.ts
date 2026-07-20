import assert from 'node:assert/strict';
import test from 'node:test';

import { requestContextStore } from '../src/common/context/request-context.js';
import { RouteController } from '../src/routing/http/route.controller.js';

const actor = { userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000003', displayName: 'Owner', authenticationMethod: 'administrator_mfa', platformRoles: [], memberships: [] } as const;

void test('route controller maps ordered stop projection and explicit replace status', async () => {
  const value = { routeId: 'route', routeVersion: 2, deliverySlotId: 'slot', serviceDate: '2026-07-20', startDate: '2026-07-20', endDate: '2026-07-31', stops: [{ id: 'stop', householdId: 'household', sequence: 1 }] };
  const service = { listStops: () => Promise.resolve(value), replaceStops: () => Promise.resolve(value) };
  const controller = new RouteController(service as never);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000002', actor }, async () => {
    assert.deepEqual(await controller.listStops('vendor', 'route', { serviceDate: '2026-07-20' }), value);
    assert.deepEqual(await controller.replaceStops('vendor', 'route', { effectiveDate: '2026-07-20', expectedVersion: 1, reason: 'Order', householdIds: ['household'] }), value);
  });
  const method = Object.getOwnPropertyDescriptor(RouteController.prototype, 'replaceStops')?.value as object;
  assert.equal(Reflect.getMetadata('__httpCode__', method), 200);
});
