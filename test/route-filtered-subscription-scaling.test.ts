import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { Actor } from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import type { RouteScheduleProjection } from '../src/routing/application/route-assignment.store.js';
import { PrismaRouteAssignmentStore } from '../src/routing/infrastructure/prisma-route-assignment.store.js';
import { DefaultSubscriptionService } from '../src/subscriptions/application/subscription.service.js';

const tx = {} as TransactionContext;
const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Administrator',
  authenticationMethod: 'administrator_mfa',
  platformRoles: [],
  memberships: [],
};
const authorization = {
  execute: (_input: unknown, work: (context: TransactionContext) => Promise<unknown>) => work(tx),
};
const vendors = { getSubscriptionTimezone: () => Promise.resolve({ timezone: 'Asia/Kolkata' }) };

void test('route-filtered subscription lookup uses one exact route projection only', async () => {
  const route: RouteScheduleProjection = {
    routeId: '00000000-0000-4000-8000-000000000010',
    routeVersion: 3,
    deliverySlotId: '00000000-0000-4000-8000-000000000011',
    stops: [{
      stopId: '00000000-0000-4000-8000-000000000012',
      householdId: '00000000-0000-4000-8000-000000000013',
      sequence: 1,
    }],
  };
  const calls: unknown[][] = [];
  let storeQuery: unknown;
  const routing = {
    project: () => { throw new Error('must not project every vendor route'); },
    projectRoute: (...args: unknown[]) => { calls.push(args); return Promise.resolve(route); },
  };
  const subscriptions = {
    list: (_context: TransactionContext, query: unknown) => {
      storeQuery = query;
      return Promise.resolve({ items: [] });
    },
  };
  const service = new DefaultSubscriptionService(
    authorization as never,
    subscriptions as never,
    {} as never,
    {} as never,
    vendors as never,
    { append: () => Promise.resolve() },
    { lock: () => Promise.resolve() },
    { write: () => Promise.resolve() },
    routing,
  );

  await service.list(actor, '00000000-0000-4000-8000-000000000020', {
    routeId: route.routeId,
    routeServiceDate: '2099-07-20',
    productId: '00000000-0000-4000-8000-000000000021',
    limit: 1,
  });

  assert.deepEqual(calls, [[tx, '00000000-0000-4000-8000-000000000020', route.routeId, '2099-07-20']]);
  assert.deepEqual(storeQuery, {
    productId: '00000000-0000-4000-8000-000000000021',
    limit: 1,
    route: {
      serviceDate: '2099-07-20',
      deliverySlotId: route.deliverySlotId,
      householdIds: ['00000000-0000-4000-8000-000000000013'],
    },
  });
});

void test('missing exact route preserves ROUTE_NOT_FOUND', async () => {
  const routing = {
    project: () => { throw new Error('must not project every vendor route'); },
    projectRoute: () => Promise.resolve(undefined),
  };
  const service = new DefaultSubscriptionService(
    authorization as never,
    { list: () => { throw new Error('must not list subscriptions'); } } as never,
    {} as never,
    {} as never,
    vendors as never,
    { append: () => Promise.resolve() },
    { lock: () => Promise.resolve() },
    { write: () => Promise.resolve() },
    routing,
  );

  await assert.rejects(
    service.list(actor, '00000000-0000-4000-8000-000000000020', {
      routeId: '00000000-0000-4000-8000-000000000010',
      routeServiceDate: '2099-07-20',
    }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === 'ROUTE_NOT_FOUND'
      && error.status === 404,
  );
});

void test('route-specific projection constrains SQL by vendor, route, active state, and date', async () => {
  const vendorId = '00000000-0000-4000-8000-000000000020';
  const routeId = '00000000-0000-4000-8000-000000000010';
  const serviceDate = '2099-07-20';
  let queryCount = 0;
  const transaction = {
    $queryRaw: (query: Readonly<{ strings: readonly string[]; values: readonly unknown[] }>) => {
      queryCount += 1;
      const sql = query.strings.join('?').replaceAll(/\s+/gu, ' ');
      assert.match(sql, /WHERE r\.vendor_id=\?::uuid AND r\.id=\?::uuid/u);
      assert.match(sql, /r\.status='active' AND r\.deleted_at IS NULL/u);
      assert.match(sql, /effective_from<=\?::date/u);
      assert.match(sql, /effective_to IS NULL OR effective_to>\?::date/u);
      assert.ok(query.values.includes(vendorId));
      assert.ok(query.values.includes(routeId));
      assert.ok(query.values.filter((value) => value === serviceDate).length >= 2);
      return Promise.resolve([{
        routeId,
        routeVersion: 3,
        deliverySlotId: '00000000-0000-4000-8000-000000000011',
        assignmentId: null,
        agentMembershipId: null,
        stopId: '00000000-0000-4000-8000-000000000012',
        householdId: '00000000-0000-4000-8000-000000000013',
        sequence: 1,
      }]);
    },
  };
  const store = new PrismaRouteAssignmentStore() as unknown as {
    projectRoute(
      context: TransactionContext,
      requestedVendorId: string,
      requestedRouteId: string,
      requestedServiceDate: string,
    ): Promise<RouteScheduleProjection | undefined>;
  };

  const result = await store.projectRoute(
    wrapPrismaTransaction(transaction as unknown as Prisma.TransactionClient),
    vendorId,
    routeId,
    serviceDate,
  );

  assert.equal(queryCount, 1);
  assert.equal(result?.routeId, routeId);
  assert.deepEqual(result?.stops.map(({ householdId }) => householdId), [
    '00000000-0000-4000-8000-000000000013',
  ]);
});
