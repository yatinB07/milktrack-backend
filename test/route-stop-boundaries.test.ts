import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { PrismaHouseholdService } from '../src/customers/application/household.service.js';

void test('Customers exposes one transaction-bound batch route household summary lock', async () => {
  const tx = {} as TransactionContext; const calls: unknown[] = [];
  const active = [{ id: 'a', accountNumber: 'A-1', name: 'A', addressLine1: 'Road', city: 'Pune', region: 'MH', postalCode: '411001', countryCode: 'IN', status: 'active' as const }];
  const historical = [{ ...active[0], status: 'inactive' as const }];
  const store = {
    requireRouteHouseholdSummaries: (context: TransactionContext, householdIds: readonly string[]) => { calls.push(['require', context, householdIds]); return Promise.resolve(active); },
    getRouteHouseholdSummaries: (context: TransactionContext, householdIds: readonly string[]) => { calls.push(['summaries', context, householdIds]); return Promise.resolve(historical); },
  };
  const service = new PrismaHouseholdService({} as never, store as never, {} as never, {} as never);
  assert.deepEqual(await service.requireRouteHouseholdSummaries(tx, ['b','a','b']), active);
  assert.deepEqual(await service.getRouteHouseholdSummaries(tx, ['a','a']), historical);
  assert.deepEqual(calls, [['require', tx, ['b','a','b']], ['summaries', tx, ['a','a']]]);
});
