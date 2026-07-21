import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { Actor } from '../src/common/context/request-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import { DefaultRouteService } from '../src/routing/application/route.service.js';

const tx = {} as TransactionContext;
const actor: Actor = { userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', displayName: 'Owner', authenticationMethod: 'administrator_mfa', platformRoles: [], memberships: [] };
const route = { id: 'route', vendorId: 'vendor', code: 'AM', name: 'Morning', deliverySlotId: 'slot', status: 'inactive' as const, lifecycle: 'current' as const, version: 2, createdAt: new Date(), updatedAt: new Date() };
const authorization = { execute: (_input: unknown, operation: (current: TransactionContext) => Promise<unknown>) => operation(tx) };
const audits = { append: () => Promise.resolve() };
const scheduleDates = { lock: () => Promise.resolve() };
const regeneration = { write: () => Promise.resolve() };

void test('reactivation locks schedule dates before the route and its immutable slot', async () => {
  const order: string[] = [];
  const routes = {
    lockRoot: () => { order.push('route-lock'); return Promise.resolve(route); },
    changeStatus: () => { order.push('route-change'); return Promise.resolve({ before: route, after: { ...route, status: 'active', version: 3 } }); },
  };
  const catalog = { requireRouteDeliverySlot: () => { order.push('slot-lock'); return Promise.resolve({ deliverySlotId: 'slot' }); } };
  const service = new DefaultRouteService(authorization as never, routes as never, {} as never, {} as never, catalog as never, {} as never, {} as never, { getSubscriptionTimezone: () => Promise.resolve({ timezone: 'Asia/Kolkata' }) } as never, audits, { lock: () => { order.push('date-lock'); return Promise.resolve(); } }, regeneration);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, () => service.reactivate(actor, 'vendor', 'route', { expectedVersion: 2, reason: 'Resume route' }));
  assert.deepEqual(order, ['date-lock', 'route-lock', 'slot-lock', 'route-change']);
});

void test('create normalizes route identity and audits only the safe persisted projection', async () => {
  let created: unknown; let event: unknown;
  const routes = { create: (_tx: TransactionContext, input: unknown) => { created = input; return Promise.resolve({ ...(input as object), createdAt: new Date(), updatedAt: new Date() }); } };
  const catalog = { requireRouteDeliverySlot: () => Promise.resolve({ deliverySlotId: 'slot' }) };
  const audit = { append: (_tx: TransactionContext, value: unknown) => { event = value; return Promise.resolve(); } };
  const service = new DefaultRouteService(authorization as never, routes as never, {} as never, {} as never, catalog as never, {} as never, {} as never, {} as never, audit, scheduleDates, regeneration);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, () => service.create(actor, 'vendor', { code: ' am_1 ', name: ' Morning ', deliverySlotId: 'slot' }));
  assert.equal((created as { code: string }).code, 'AM_1'); assert.equal((created as { name: string }).name, 'Morning');
  assert.deepEqual(Object.keys((event as { newValue: object }).newValue).sort(), ['code', 'deliverySlotId', 'name', 'status', 'version']);
});

void test('route root reads normalize lifecycle and stop and assignment roots stay current-only', async () => {
  const calls: unknown[][] = [];
  const routes = {
    list: (...args: unknown[]) => { calls.push(['list', ...args]); return Promise.resolve({ items: [] }); },
    get: (...args: unknown[]) => { calls.push(['get', ...args]); return Promise.resolve(route); },
  };
  const stopPlans = { list: () => Promise.resolve({ routeId: route.id, routeVersion: route.version, deliverySlotId: route.deliverySlotId, serviceDate: '2099-01-01', stops: [] }) };
  const assignments = { list: () => Promise.resolve({ items: [] }) };
  const service = new DefaultRouteService(authorization as never, routes as never, stopPlans as never, assignments as never, {} as never, { getRouteHouseholdSummaries: () => Promise.resolve([]) } as never, {} as never, {} as never, audits, scheduleDates, regeneration);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, async () => {
    await service.list(actor, 'vendor', { lifecycle: 'current' });
    await service.get(actor, 'vendor', 'route', 'deleted');
    await service.listStops(actor, 'vendor', 'route', { serviceDate: '2099-01-01' });
    await service.listAssignments(actor, 'vendor', 'route', {});
  });
  assert.equal((calls.filter(([kind]) => kind === 'list')[0]?.at(-1) as { lifecycle: string }).lifecycle, 'current');
  assert.deepEqual(calls.filter(([kind]) => kind === 'get').map(([, , , lifecycle]) => lifecycle), ['deleted', 'current', 'current']);
});

void test('route readers can access current roots but not deleted roots', async () => {
  const calls: Array<{ permission: string; operation: string }> = [];
  const readOnlyAuthorization = {
    execute: (input: { permission: string; operation: string }, operation: (current: TransactionContext) => Promise<unknown>) => {
      calls.push(input);
      if (input.permission === 'route:manage') return Promise.reject(new ApplicationError('FORBIDDEN', 'You are not allowed to perform this action', 403));
      return operation(tx);
    },
  };
  const routes = { list: () => Promise.resolve({ items: [route] }), get: () => Promise.resolve(route) };
  const service = new DefaultRouteService(readOnlyAuthorization as never, routes as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, audits, scheduleDates, regeneration);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, async () => {
    assert.equal((await service.list(actor, 'vendor', { lifecycle: 'current' })).items.length, 1);
    await assert.rejects(service.list(actor, 'vendor', { lifecycle: 'deleted' }), (cause: unknown) => cause instanceof ApplicationError && cause.status === 403);
    await assert.rejects(service.get(actor, 'vendor', 'route', 'deleted'), (cause: unknown) => cause instanceof ApplicationError && cause.status === 403);
  });
  assert.deepEqual(calls.map(({ permission, operation }) => [permission, operation]), [
    ['route:read', 'route.list'], ['route:manage', 'route.deleted-list'], ['route:manage', 'route.deleted-get'],
  ]);
});

void test('route services derive lifecycle without returning persistence deletion metadata', async () => {
  const persisted = { id: 'route', vendorId: 'vendor', code: 'AM', name: 'Morning', deliverySlotId: 'slot', status: 'inactive' as const, version: 2, deletedAt: new Date('2026-07-20T00:00:00Z'), createdAt: new Date(), updatedAt: new Date() };
  const service = new DefaultRouteService(authorization as never, { list: () => Promise.resolve({ items: [persisted] }) } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, audits, scheduleDates, regeneration);
  const page = await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, () => service.list(actor, 'vendor', { lifecycle: 'deleted' }));
  assert.equal(page.items[0]?.lifecycle, 'deleted');
  assert.equal('deletedAt' in (page.items[0] ?? {}), false);
});
