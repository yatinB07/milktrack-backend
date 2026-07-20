import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { PrismaHouseholdService } from '../src/customers/application/household.service.js';

void test('Customers exposes a transaction-bound locked active route household boundary', async () => {
  const tx = {} as TransactionContext; const calls: unknown[] = [];
  const store = { requireRouteHousehold: (context: TransactionContext, householdId: string) => { calls.push([context, householdId]); return Promise.resolve({ householdId }); } };
  const service = new PrismaHouseholdService({} as never, store as never, {} as never, {} as never);
  assert.deepEqual(await service.requireRouteHousehold(tx, 'household'), { householdId: 'household' });
  assert.deepEqual(calls, [[tx, 'household']]);
});
