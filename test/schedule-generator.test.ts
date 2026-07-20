import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { SchedulingPriceService } from '../src/pricing/application/scheduling-price.service.js';
import { RoutingScheduleService } from '../src/routing/application/routing-schedule.service.js';
import { ScheduleDateLock } from '../src/schedule-coordination/application/schedule-date-lock.js';
import { DefaultScheduleGenerator } from '../src/scheduling/application/schedule-generator.js';
import { ScheduledDeliveryStore } from '../src/scheduling/application/scheduled-delivery.store.js';
import type { ScheduleTarget } from '../src/scheduling/domain/schedule-reconciliation.js';
import { SubscriptionScheduleService } from '../src/subscriptions/application/subscription-schedule.service.js';

const transaction = Object.freeze({}) as TransactionContext;

void test('generator locks first, batches projections, maps exact slot/household routes, and counts missing prices', async () => {
  const calls: string[] = [];
  let written: ScheduleTarget[] = [];
  const dates: ScheduleDateLock = { lock: (_tx, vendorId, serviceDates) => { calls.push(`lock:${vendorId}:${serviceDates.join()}`); return Promise.resolve(); } };
  const subscriptions: SubscriptionScheduleService = { project: () => {
    calls.push('subscriptions');
    return Promise.resolve([
      { subscriptionId: 's1', revisionId: 'r1', householdId: 'h1', productId: 'p1', unitId: 'u1', deliverySlotId: 'slot1', plannedQuantity: '1.25' },
      { subscriptionId: 's2', revisionId: 'r2', householdId: 'h2', productId: 'p1', unitId: 'u1', deliverySlotId: 'slot1', plannedQuantity: '2' },
    ]);
  } };
  const routing: RoutingScheduleService = { project: () => {
    calls.push('routing');
    return Promise.resolve([{ routeId: 'route', routeVersion: 1, deliverySlotId: 'slot1', stops: [{ stopId: 'stop', householdId: 'h1', sequence: 1 }], assignment: { assignmentId: 'assignment', agentMembershipId: 'agent' } }]);
  } };
  const prices: SchedulingPriceService = { resolveMany: (_tx, _vendor, _date, candidates) => {
    calls.push(`prices:${candidates.length}`);
    return Promise.resolve(candidates.map((candidate, index) => ({ ...candidate, status: index === 0 ? 'resolved' as const : 'missing' as const })));
  } };
  const deliveries: ScheduledDeliveryStore = {
    reconcile: (_tx, _vendor, _date, targets) => {
      calls.push('reconcile'); written = targets;
      return Promise.resolve({ created: 2, existing: 0, updated: 0, cancelled: 0 });
    },
    listSelf: () => Promise.resolve({ items: [] }),
  };

  const result = await new DefaultScheduleGenerator(dates, subscriptions, routing, prices, deliveries)
    .generate(transaction, 'vendor', '2026-07-20');

  assert.deepEqual(calls, ['lock:vendor:2026-07-20', 'subscriptions', 'routing', 'prices:2', 'reconcile']);
  assert.equal(written[0]?.routeAssignmentId, 'assignment');
  assert.equal(written[1]?.routeAssignmentId, null);
  assert.deepEqual(result, { created: 2, existing: 0, updated: 0, cancelled: 0, missingPrice: 1 });
});
