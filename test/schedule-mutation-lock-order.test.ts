import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { Actor } from '../src/common/context/request-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { DefaultRouteService } from '../src/routing/application/route.service.js';
import { scheduleHorizon } from '../src/schedule-coordination/application/schedule-horizon.js';
import { DefaultSubscriptionService } from '../src/subscriptions/application/subscription.service.js';

const tx = {} as TransactionContext;
const actor: Actor = { userId: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', displayName: 'Owner', authenticationMethod: 'administrator_mfa', platformRoles: [], memberships: [] };
const authorization = { execute: (_input: unknown, work: (context: TransactionContext) => Promise<unknown>) => work(tx) };
const timezone = { getSubscriptionTimezone: () => Promise.resolve({ timezone: 'Asia/Kolkata' }) };
const regeneration = { write: () => Promise.resolve() };

void test('route lifecycle acquires the ascending seven-day schedule horizon before its aggregate lock', async () => {
  const calls: string[] = []; const today = DateTime.now().setZone('Asia/Kolkata').toISODate()!;
  const route = { id: 'route', vendorId: 'vendor', code: 'R', name: 'Route', deliverySlotId: 'slot', status: 'inactive' as const, version: 1, createdAt: new Date(), updatedAt: new Date() };
  const routes = {
    lockRoot: () => { calls.push('route'); return Promise.resolve(route); },
    changeStatus: () => { calls.push('change'); return Promise.resolve({ before: route, after: { ...route, status: 'active' as const, version: 2 } }); },
  };
  const lock = { lock: (_tx: TransactionContext, _vendorId: string, dates: string[]) => { calls.push(`dates:${dates.join(',')}`); return Promise.resolve(); } };
  const service = new DefaultRouteService(authorization as never, routes as never, {} as never, {} as never, { requireRouteDeliverySlot: () => { calls.push('slot'); return Promise.resolve({}); } } as never, {} as never, {} as never, timezone as never, { append: () => Promise.resolve() }, lock, regeneration);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, () => service.reactivate(actor, 'vendor', 'route', { expectedVersion: 1, reason: 'Resume route' }));
  assert.deepEqual(calls, [`dates:${scheduleHorizon(today).join(',')}`, 'route', 'slot', 'change']);
});

void test('subscription creation locks only applicable horizon weekdays before configuration reads', async () => {
  const calls: string[] = []; const today = DateTime.now().setZone('Asia/Kolkata').toISODate()!;
  const weekdays = [DateTime.fromISO(today, { zone: 'utc' }).weekday];
  const aggregate = { id: 'subscription', vendorId: 'vendor', householdId: 'household', version: 1, createdAt: new Date(), updatedAt: new Date(), revisions: [{ id: 'revision', vendorId: 'vendor', subscriptionId: 'subscription', productId: 'product', unitId: 'unit', deliverySlotId: 'slot', quantity: '1', weekdays, status: 'active' as const, effectiveFrom: today, createdBy: actor.userId, createdAt: new Date(), updatedAt: new Date() }] };
  const lock = { lock: (_tx: TransactionContext, _vendorId: string, dates: string[]) => { calls.push(`dates:${dates.join(',')}`); return Promise.resolve(); } };
  const service = new DefaultSubscriptionService(authorization as never, { create: () => { calls.push('create'); return Promise.resolve(aggregate); } } as never, { requireSubscriptionSelection: () => { calls.push('catalog'); return Promise.resolve({ unitDecimalScale: 0 }); } } as never, { requireSubscriptionHousehold: () => { calls.push('household'); return Promise.resolve({}); } } as never, timezone as never, { append: () => Promise.resolve() }, lock, regeneration, {} as never);
  await requestContextStore.run({ correlationId: '00000000-0000-4000-8000-000000000003' }, () => service.create(actor, 'vendor', { householdId: 'household', productId: 'product', unitId: 'unit', deliverySlotId: 'slot', quantity: '1', weekdays, startDate: today }));
  assert.equal(calls[0], `dates:${today}`);
  assert.deepEqual(calls.slice(1), ['household', 'catalog', 'create']);
});
