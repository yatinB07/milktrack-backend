import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { PrismaHouseholdService } from '../src/customers/application/household.service.js';

void test('Customers exposes one transaction-bound batch route household lock', async () => {
  const tx = {} as TransactionContext; const calls: unknown[] = [];
  const summaries = [{ id: 'a', accountNumber: 'A-1', name: 'A', addressLine1: 'Road', city: 'Pune', region: 'MH', postalCode: '411001', countryCode: 'IN', status: 'inactive' as const }];
  const store = {
    requireRouteHouseholds: (context: TransactionContext, householdIds: readonly string[]) => { calls.push(['require', context, householdIds]); return Promise.resolve({ householdIds }); },
    getRouteHouseholdSummaries: (context: TransactionContext, householdIds: readonly string[]) => { calls.push(['summaries', context, householdIds]); return Promise.resolve(summaries); },
  };
  const service = new PrismaHouseholdService({} as never, store as never, {} as never, {} as never);
  assert.deepEqual(await service.requireRouteHouseholds(tx, ['b','a','b']), { householdIds: ['b','a','b'] });
  assert.deepEqual(await service.getRouteHouseholdSummaries(tx, ['a','a']), summaries);
  assert.deepEqual(calls, [['require', tx, ['b','a','b']], ['summaries', tx, ['a','a']]]);
});
