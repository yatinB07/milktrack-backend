import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { Actor } from '../src/common/context/request-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { DefaultRouteService } from '../src/routing/application/route.service.js';

const tx = {} as TransactionContext;
const actor: Actor = { userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', displayName: 'Owner', authenticationMethod: 'administrator_mfa', platformRoles: [], memberships: [] };
const route = { id: 'route', vendorId: 'vendor', code: 'AM', name: 'Morning', deliverySlotId: 'slot', status: 'inactive' as const, version: 2, createdAt: new Date(), updatedAt: new Date() };
const authorization = { execute: (_input: unknown, operation: (current: TransactionContext) => Promise<unknown>) => operation(tx) };
const audits = { append: () => Promise.resolve() };
const scheduleDates = { lock: () => Promise.resolve() };

void test('reactivation locks schedule dates before the route and its immutable slot', async () => {
  const order: string[] = [];
  const routes = {
    lockRoot: () => { order.push('route-lock'); return Promise.resolve(route); },
    changeStatus: () => { order.push('route-change'); return Promise.resolve({ before: route, after: { ...route, status: 'active', version: 3 } }); },
  };
  const catalog = { requireRouteDeliverySlot: () => { order.push('slot-lock'); return Promise.resolve({ deliverySlotId: 'slot' }); } };
  const service = new DefaultRouteService(authorization as never, routes as never, {} as never, {} as never, catalog as never, {} as never, {} as never, { getSubscriptionTimezone: () => Promise.resolve({ timezone: 'Asia/Kolkata' }) } as never, audits, { lock: () => { order.push('date-lock'); return Promise.resolve(); } });
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, () => service.reactivate(actor, 'vendor', 'route', { expectedVersion: 2, reason: 'Resume route' }));
  assert.deepEqual(order, ['date-lock', 'route-lock', 'slot-lock', 'route-change']);
});

void test('create normalizes route identity and audits only the safe persisted projection', async () => {
  let created: unknown; let event: unknown;
  const routes = { create: (_tx: TransactionContext, input: unknown) => { created = input; return Promise.resolve({ ...(input as object), createdAt: new Date(), updatedAt: new Date() }); } };
  const catalog = { requireRouteDeliverySlot: () => Promise.resolve({ deliverySlotId: 'slot' }) };
  const audit = { append: (_tx: TransactionContext, value: unknown) => { event = value; return Promise.resolve(); } };
  const service = new DefaultRouteService(authorization as never, routes as never, {} as never, {} as never, catalog as never, {} as never, {} as never, {} as never, audit, scheduleDates);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, () => service.create(actor, 'vendor', { code: ' am_1 ', name: ' Morning ', deliverySlotId: 'slot' }));
  assert.equal((created as { code: string }).code, 'AM_1'); assert.equal((created as { name: string }).name, 'Morning');
  assert.deepEqual(Object.keys((event as { newValue: object }).newValue).sort(), ['code', 'deliverySlotId', 'name', 'status', 'version']);
});
