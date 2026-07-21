import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DateTime } from 'luxon';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { Actor } from '../src/common/context/request-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { DefaultRouteService } from '../src/routing/application/route.service.js';
import { scheduleHorizon } from '../src/schedule-coordination/application/schedule-horizon.js';
import { DefaultSubscriptionService } from '../src/subscriptions/application/subscription.service.js';

const tx = {} as TransactionContext;
const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Owner',
  authenticationMethod: 'administrator_mfa',
  platformRoles: [],
  memberships: [],
};
const authorization = {
  execute: (_input: unknown, work: (context: TransactionContext) => Promise<unknown>) => work(tx),
};
const today = DateTime.now().setZone('UTC').toISODate()!;
const vendors = { getSubscriptionTimezone: () => Promise.resolve({ timezone: 'UTC' }) };
const audits = { append: () => Promise.resolve() };
const scheduleDates = { lock: () => Promise.resolve() };

void test('schedule regeneration is a required service dependency', async () => {
  const sources = await Promise.all([
    readFile(new URL('../src/subscriptions/application/subscription.service.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/routing/application/route.service.ts', import.meta.url), 'utf8'),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /regeneration\?: ScheduleRegenerationWriter/u);
    assert.doesNotMatch(source, /regeneration\?\.write/u);
  }
});

for (const operation of ['create', 'modify', 'pause', 'resume', 'cancel', 'softDelete', 'restore'] as const) {
  void test(`subscription ${operation} enqueues every locked current-horizon date`, async () => {
    const writes: string[][] = [];
    const activeRevision = {
      id: 'revision', vendorId: 'vendor', subscriptionId: 'subscription', productId: 'product', unitId: 'unit',
      deliverySlotId: 'slot', quantity: '1', weekdays: [1, 2, 3, 4, 5, 6, 7],
      status: operation === 'resume' ? 'paused' : 'active', effectiveFrom: today,
      createdBy: actor.userId, createdAt: new Date(), updatedAt: new Date(),
    };
    const terminalRevision = { ...activeRevision, status: 'cancelled' as const };
    const aggregate = {
      id: 'subscription', vendorId: 'vendor', householdId: 'household', version: 1,
      createdAt: new Date(), updatedAt: new Date(),
      revisions: operation === 'softDelete' || operation === 'restore' ? [terminalRevision] : [activeRevision],
    };
    const changed = { ...aggregate, version: 2, replacementRevisionId: 'replacement', supersededRevisionIds: ['revision'], supersededRevisionCount: 1 };
    const store = {
      create: () => Promise.resolve(aggregate),
      lockForMutation: () => Promise.resolve({ ...aggregate, selected: activeRevision }),
      replacePlan: () => Promise.resolve(changed),
      lockRoot: () => Promise.resolve(aggregate),
      softDelete: () => Promise.resolve({ ...aggregate, version: 2, deletedAt: new Date() }),
      restore: () => Promise.resolve({ ...aggregate, version: 2 }),
    };
    const writer = { write: (_tx: TransactionContext, _vendorId: string, _triggerDate: string, dates: readonly string[]) => { writes.push([...dates]); return Promise.resolve(); } };
    const service = new DefaultSubscriptionService(
      authorization as never, store as never,
      { requireSubscriptionSelection: () => Promise.resolve({ unitDecimalScale: 0 }) } as never,
      { requireSubscriptionHousehold: () => Promise.resolve({}) } as never,
      vendors as never, audits, scheduleDates, writer, {} as never,
    );

    await requestContextStore.run({ correlationId: 'correlation' }, async () => {
      if (operation === 'create') await service.create(actor, 'vendor', { householdId: 'household', productId: 'product', unitId: 'unit', deliverySlotId: 'slot', quantity: '1', weekdays: [1, 2, 3, 4, 5, 6, 7], startDate: today });
      else if (operation === 'modify') await service.modify(actor, 'vendor', 'subscription', { productId: 'product', unitId: 'unit', deliverySlotId: 'slot', quantity: '1', weekdays: [1, 2, 3, 4, 5, 6, 7], effectiveDate: today, expectedVersion: 1, reason: 'Change', });
      else if (operation === 'softDelete') await service.softDelete(actor, 'vendor', 'subscription', { expectedVersion: 1, reason: 'Archive' });
      else if (operation === 'restore') await service.restore(actor, 'vendor', 'subscription', { expectedVersion: 1, reason: 'Restore' });
      else await service[operation](actor, 'vendor', 'subscription', { effectiveDate: today, expectedVersion: 1, reason: 'Change' });
    });

    assert.deepEqual(writes, [scheduleHorizon(today)]);
  });
}

for (const operation of ['deactivate', 'reactivate', 'softDelete', 'restore', 'replaceStops', 'assign', 'cancelAssignment'] as const) {
  void test(`route ${operation} enqueues every locked current-horizon date`, async () => {
    const writes: string[][] = [];
    const route = {
      id: 'route', vendorId: 'vendor', code: 'AM', name: 'Morning', deliverySlotId: 'slot',
      status: operation === 'softDelete' || operation === 'reactivate' ? 'inactive' : 'active',
      version: 1, createdAt: new Date(), updatedAt: new Date(),
    };
    const assignment = { id: 'assignment', routeId: route.id, deliverySlotId: route.deliverySlotId, agentMembershipId: 'agent', serviceDate: today, status: 'assigned' as const, createdAt: new Date(), updatedAt: new Date() };
    const routes = {
      lockRoot: () => Promise.resolve(route),
      changeStatus: () => Promise.resolve({ before: route, after: { ...route, version: 2 } }),
      softDelete: () => Promise.resolve({ before: route, after: { ...route, version: 2, deletedAt: new Date() } }),
      restore: () => Promise.resolve({ before: route, after: { ...route, version: 2 } }),
    };
    const stopPlans = {
      hasCurrentOrFutureStops: () => Promise.resolve(false),
      replace: () => Promise.resolve({ projection: { routeId: route.id, routeVersion: 2, serviceDate: today, stops: [] }, previous: { stops: [] } }),
    };
    const assignments = {
      hasAssignedOnOrAfter: () => Promise.resolve(false),
      assign: () => Promise.resolve({ assignment, routeVersion: 2, created: true }),
      cancel: () => Promise.resolve({ assignment: { ...assignment, status: 'cancelled' as const }, previous: assignment, routeVersion: 2, created: false }),
    };
    const writer = { write: (_tx: TransactionContext, _vendorId: string, _triggerDate: string, dates: readonly string[]) => { writes.push([...dates]); return Promise.resolve(); } };
    const service = new DefaultRouteService(
      authorization as never, routes as never, stopPlans as never, assignments as never,
      { requireRouteDeliverySlot: () => Promise.resolve({}) } as never,
      { requireRouteHouseholds: () => Promise.resolve(), getRouteHouseholdSummaries: () => Promise.resolve([]) } as never,
      { requireRouteAgent: () => Promise.resolve({}) } as never,
      vendors as never, audits, scheduleDates, writer,
    );

    await requestContextStore.run({ correlationId: 'correlation' }, async () => {
      if (operation === 'replaceStops') await service.replaceStops(actor, 'vendor', 'route', { effectiveDate: today, expectedVersion: 1, reason: 'Stops', householdIds: [] });
      else if (operation === 'assign') await service.assign(actor, 'vendor', 'route', today, { agentMembershipId: 'agent', expectedVersion: 1, reason: 'Assign' });
      else if (operation === 'cancelAssignment') await service.cancelAssignment(actor, 'vendor', 'route', today, { expectedVersion: 1, reason: 'Cancel' });
      else await service[operation](actor, 'vendor', 'route', { expectedVersion: 1, reason: 'Change' });
    });

    assert.deepEqual(writes, [operation === 'assign' || operation === 'cancelAssignment' ? [today] : scheduleHorizon(today)]);
  });
}
