import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { PrismaHouseholdService } from '../src/customers/application/household.service.js';

void test('Customers exposes one transaction-bound batch route household lock', async () => {
  const tx = {} as TransactionContext; const calls: unknown[] = [];
  const store = { requireRouteHouseholds: (context: TransactionContext, householdIds: readonly string[]) => { calls.push([context, householdIds]); return Promise.resolve({ householdIds }); } };
  const service = new PrismaHouseholdService({} as never, store as never, {} as never, {} as never);
  assert.deepEqual(await service.requireRouteHouseholds(tx, ['b','a','b']), { householdIds: ['b','a','b'] });
  assert.deepEqual(calls, [[tx, ['b','a','b']]]);
});
