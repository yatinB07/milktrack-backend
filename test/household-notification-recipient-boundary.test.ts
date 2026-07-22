import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { PrismaHouseholdService } from '../src/customers/application/household.service.js';
import { PrismaHouseholdStore } from '../src/customers/infrastructure/prisma-household.store.js';
import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';

const vendorId = '00000000-0000-4000-8000-000000000001';
const householdA = '00000000-0000-4000-8000-000000000002';
const householdB = '00000000-0000-4000-8000-000000000003';
const userA = '00000000-0000-4000-8000-000000000004';
const userB = '00000000-0000-4000-8000-000000000005';

void test('customer application boundary preserves the caller transaction and batch', async () => {
  const tx = {} as TransactionContext;
  const expected = new Map([[householdA, [userA]]]);
  const calls: unknown[][] = [];
  const service = new PrismaHouseholdService({} as never, {
    getNotificationRecipientUserIds: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(expected);
    },
  } as never, {} as never, {} as never);

  assert.equal(await service.getNotificationRecipientUserIds(tx, vendorId, [householdA]), expected);
  assert.deepEqual(calls, [[tx, vendorId, [householdA]]]);
});

void test('customer store returns tenant-scoped active recipients grouped and deduplicated', async () => {
  const queries: unknown[] = [];
  const tx = wrapPrismaTransaction({
    $queryRaw: (query: unknown) => {
      queries.push(query);
      return Promise.resolve([
        { householdId: householdA, userId: userA },
        { householdId: householdA, userId: userA },
        { householdId: householdA, userId: userB },
      ]);
    },
  } as never);

  const result = await new PrismaHouseholdStore().getNotificationRecipientUserIds(
    tx,
    vendorId,
    [householdB, householdA, householdA],
  );

  assert.deepEqual(result, new Map([[householdA, [userA, userB]], [householdB, []]]));
  const sql = (queries[0] as { strings: readonly string[] }).strings.join(' ');
  assert.match(sql, /m\.vendor_id=/u);
  assert.match(sql, /m\.status='active'/u);
  assert.match(sql, /v\.status='active'/u);
  assert.match(sql, /ORDER BY m\.household_id,v\.user_id/u);
});
