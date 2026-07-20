import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import { PrismaScheduleRegenerationWriter } from '../src/schedule-coordination/infrastructure/prisma-schedule-regeneration-writer.js';

void test('configuration regeneration coalesces duplicate dates in ascending lock order', async () => {
  const queries: unknown[] = [];
  const tx = wrapPrismaTransaction({
    $executeRaw: (query: unknown) => {
      queries.push(query);
      return Promise.resolve(1);
    },
  } as never);

  await new PrismaScheduleRegenerationWriter().write(
    tx,
    '00000000-0000-4000-8000-000000000001',
    '2030-01-01',
    ['2030-01-03', '2030-01-01', '2030-01-03'],
    '00000000-0000-4000-8000-000000000002',
  );

  assert.equal(queries.length, 2);
  assert.deepEqual(
    queries.map((query) => (query as { values: unknown[] }).values.slice(1, 4)),
    [
      ['00000000-0000-4000-8000-000000000001', '2030-01-01', '2030-01-01'],
      ['00000000-0000-4000-8000-000000000001', '2030-01-01', '2030-01-03'],
    ],
  );
  for (const query of queries) {
    const sql = (query as { strings: readonly string[] }).strings.join('');
    assert.match(sql, /ON CONFLICT \(vendor_id,service_date\)/u);
    assert.match(sql, /trigger='configuration_change'/u);
  }
});

void test('configuration mutations enqueue only after their audit within the held date-lock transaction', async () => {
  const calls: string[] = [];
  const tx = {} as TransactionContext;
  const writer = {
    write: (_tx: TransactionContext, _vendorId: string, _today: string, dates: readonly string[]) => {
      calls.push(`enqueue:${dates.join(',')}`);
      return Promise.resolve();
    },
  };
  const authorization = {
    execute: (_input: unknown, work: (current: TransactionContext) => Promise<unknown>) => work(tx),
  };
  const actor = {
    userId: '00000000-0000-4000-8000-000000000002', sessionId: 'session', displayName: 'Owner',
    authenticationMethod: 'administrator_mfa' as const, platformRoles: [], memberships: [],
  };
  const today = DateTime.now().setZone('UTC').toISODate()!;
  const service = new (await import('../src/subscriptions/application/subscription.service.js')).DefaultSubscriptionService(
    authorization as never,
    { create: () => { calls.push('mutation'); return Promise.resolve({ id: 'subscription', vendorId: 'vendor', householdId: 'household', version: 1, createdAt: new Date(), updatedAt: new Date(), revisions: [] }); } } as never,
    { requireSubscriptionSelection: () => { calls.push('catalog'); return Promise.resolve({ unitDecimalScale: 0 }); } } as never,
    { requireSubscriptionHousehold: () => { calls.push('household'); return Promise.resolve({}); } } as never,
    { getSubscriptionTimezone: () => Promise.resolve({ timezone: 'UTC' }) } as never,
    { append: () => { calls.push('audit'); return Promise.resolve(); } },
    { lock: (_tx: TransactionContext, _vendorId: string, dates: string[]) => { calls.push(`lock:${dates.join(',')}`); return Promise.resolve(); } },
    writer,
  );

  const { requestContextStore } = await import('../src/common/context/request-context.js');
  await requestContextStore.run({ correlationId: 'correlation' }, () => service.create(actor, 'vendor', {
    householdId: 'household', productId: 'product', unitId: 'unit', deliverySlotId: 'slot', quantity: '1', weekdays: [2], startDate: today,
  }));

  assert.deepEqual(calls.slice(1, 5), ['household', 'catalog', 'mutation', 'audit']);
  assert.equal(calls[0], calls[5].replace('enqueue:', 'lock:'));
});

void test('a failed configuration enqueue rejects the mutation transaction after its audit', async () => {
  let committed = false;
  const tx = {} as TransactionContext;
  const authorization = {
    execute: async (_input: unknown, work: (current: TransactionContext) => Promise<unknown>) => {
      const result = await work(tx);
      committed = true;
      return result;
    },
  };
  const actor = {
    userId: '00000000-0000-4000-8000-000000000002', sessionId: 'session', displayName: 'Owner',
    authenticationMethod: 'administrator_mfa' as const, platformRoles: [], memberships: [],
  };
  const today = DateTime.now().setZone('UTC').toISODate()!;
  let audited = false;
  const service = new (await import('../src/subscriptions/application/subscription.service.js')).DefaultSubscriptionService(
    authorization as never,
    { create: () => Promise.resolve({ id: 'subscription', vendorId: 'vendor', householdId: 'household', version: 1, createdAt: new Date(), updatedAt: new Date(), revisions: [] }) } as never,
    { requireSubscriptionSelection: () => Promise.resolve({ unitDecimalScale: 0 }) } as never,
    { requireSubscriptionHousehold: () => Promise.resolve({}) } as never,
    { getSubscriptionTimezone: () => Promise.resolve({ timezone: 'UTC' }) } as never,
    { append: () => { audited = true; return Promise.resolve(); } },
    { lock: () => Promise.resolve() },
    { write: () => Promise.reject(new Error('enqueue failed')) },
  );

  const { requestContextStore } = await import('../src/common/context/request-context.js');
  await assert.rejects(requestContextStore.run({ correlationId: 'correlation' }, () => service.create(actor, 'vendor', {
    householdId: 'household', productId: 'product', unitId: 'unit', deliverySlotId: 'slot', quantity: '1', weekdays: [1, 2, 3, 4, 5, 6, 7], startDate: today,
  })), /enqueue failed/u);
  assert.equal(audited, true);
  assert.equal(committed, false);
});
