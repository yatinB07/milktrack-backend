import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { requireVendorOperation, requireVendorPermission } from '../src/authorization/application/authorization.policy.js';
import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import { LeaveStore } from '../src/leave/application/leave.store.js';
import { DefaultSchedulingLeaveService, SchedulingLeaveService } from '../src/leave/application/scheduling-leave.service.js';
import { ScheduleDateLock } from '../src/schedule-coordination/application/schedule-date-lock.js';
import { SchedulingPriceService } from '../src/pricing/application/scheduling-price.service.js';
import { RoutingScheduleService } from '../src/routing/application/routing-schedule.service.js';
import { DefaultScheduleGenerator } from '../src/scheduling/application/schedule-generator.js';
import { ScheduledDeliveryStore } from '../src/scheduling/application/scheduled-delivery.store.js';
import { SubscriptionScheduleService } from '../src/subscriptions/application/subscription-schedule.service.js';

void test('scheduling publishes database-only coordination and batch projection boundaries', () => {
  assert.equal(typeof ScheduleDateLock, 'function');
  assert.equal(typeof SubscriptionScheduleService, 'function');
  assert.equal(typeof SchedulingPriceService, 'function');
  assert.equal(typeof SchedulingLeaveService, 'function');
});

void test('schedule generation resolves effective leave before reconciling targets', async () => {
  const calls: string[] = [];
  const tx = {} as TransactionContext;
  const dates: ScheduleDateLock = { lock: () => { calls.push('lock'); return Promise.resolve(); } };
  const subscriptions: SubscriptionScheduleService = { project: () => Promise.resolve([{
    subscriptionId: 'subscription', revisionId: 'revision', householdId: 'household', productId: 'product',
    unitId: 'unit', deliverySlotId: 'slot', plannedQuantity: '1',
  }]) };
  const routing: RoutingScheduleService = { project: () => Promise.resolve([]), projectRoute: () => Promise.resolve(undefined) };
  const pricing: SchedulingPriceService = { resolveMany: () => Promise.resolve([]) };
  const leave: SchedulingLeaveService = { effectiveOccurrences: (_tx, _vendorId, _serviceDate, candidates) => {
    calls.push(`leave:${candidates.length}`);
    return Promise.resolve(new Set(['subscription:slot']));
  } };
  const deliveries: ScheduledDeliveryStore = {
    reconcile: (_tx, _vendorId, _serviceDate, _targets, effectiveLeave) => {
      calls.push(`reconcile:${[...effectiveLeave].join()}`);
      return Promise.resolve({ created: 1, existing: 0, updated: 0, cancelled: 0 });
    },
    listSelf: () => Promise.resolve({ items: [] }),
  };

  await new DefaultScheduleGenerator(dates, subscriptions, routing, pricing, leave, deliveries)
    .generate(tx, 'vendor', '2030-01-01');

  assert.deepEqual(calls, ['lock', 'leave:1', 'reconcile:subscription:slot']);
});

void test('scheduling leave resolution collapses duplicates, short-circuits empty input, and batches once', async () => {
  const tx = {} as TransactionContext;
  const calls: unknown[] = [];
  const store = {
    effectiveOccurrenceKeys: (_tx: TransactionContext, input: unknown) => {
      calls.push(input);
      return Promise.resolve(new Set(['2030-01-01:subscription:slot']));
    },
  } as unknown as LeaveStore;
  const leave = new DefaultSchedulingLeaveService(store);

  assert.deepEqual(await leave.effectiveOccurrences(tx, 'vendor', '2030-01-01', []), new Set());
  assert.equal(calls.length, 0);
  assert.deepEqual(await leave.effectiveOccurrences(tx, 'vendor', '2030-01-01', [
    { subscriptionId: 'subscription', deliverySlotId: 'slot' },
    { subscriptionId: 'subscription', deliverySlotId: 'slot' },
    { subscriptionId: 'other', deliverySlotId: 'slot' },
  ]), new Set(['subscription:slot']));
  assert.deepEqual(calls, [{
    vendorId: 'vendor',
    candidates: [
      { subscriptionId: 'subscription', deliverySlotId: 'slot', serviceDate: '2030-01-01' },
      { subscriptionId: 'other', deliverySlotId: 'slot', serviceDate: '2030-01-01' },
    ],
  }]);
});

void test('leave and delivery-policy operations use only existing reviewed permissions', () => {
  for (const operation of ['leave.preview', 'leave.create', 'leave.list', 'leave.get', 'leave.amend', 'leave.cancel', 'notification.self-list']) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'customer:self'));
  }
  for (const operation of ['leave.decision-list', 'leave.vendor-get']) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'schedule:read'));
  }
  for (const operation of ['leave.decision', 'vendor.delivery-policy.update']) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'schedule:manage'));
  }
  for (const operation of ['delivery.list', 'delivery.get']) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'schedule:read'));
  }
  assert.doesNotThrow(() => requireVendorOperation('delivery.correct', 'schedule:manage'));
  assert.doesNotThrow(() => requireVendorOperation('delivery.stop-outcome', 'delivery:record'));
  for (const operation of ['delivery.self-list', 'delivery.self-get']) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'customer:self'));
  }
  assert.doesNotThrow(() => requireVendorOperation('vendor.profile.read', 'vendor:profile:read'));
  for (const role of ['vendor_owner', 'vendor_administrator'] as const) {
    assert.doesNotThrow(() => requireVendorPermission(role, 'schedule:read'));
    assert.doesNotThrow(() => requireVendorPermission(role, 'schedule:manage'));
  }
  const forbidden = (error: unknown) => error instanceof ApplicationError && error.code === 'FORBIDDEN';
  for (const role of ['delivery_agent', 'customer'] as const) {
    assert.throws(() => requireVendorPermission(role, 'schedule:manage'), forbidden);
  }
});

void test('schedule generation composes leave without forwardRef or a module cycle', async () => {
  const [generation, scheduling, leave, leaveScheduling, worker] = await Promise.all([
    readFile(new URL('../src/scheduling/schedule-generation.module.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/scheduling/scheduling.module.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/leave/leave.module.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/leave/leave-scheduling.module.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/schedule-worker.module.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(generation, /LeaveSchedulingModule/u);
  assert.doesNotMatch(generation, /leave\/infrastructure/u);
  assert.doesNotMatch(generation, /LeaveModule/u);
  assert.match(scheduling, /LeaveModule/u);
  assert.doesNotMatch(generation + scheduling + leave + leaveScheduling + worker, /forwardRef/u);
  assert.doesNotMatch(leave, /ScheduleGenerationModule/u);
  assert.doesNotMatch(leaveScheduling + worker, /IdentityModule|Controller/u);
});
