import assert from 'node:assert/strict';
import test from 'node:test';

import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaSubscriptionLabelReader } from '../src/subscriptions/infrastructure/prisma-subscription-label.reader.js';

const vendorId = '00000000-0000-4000-8000-000000000001';
const householdId = '00000000-0000-4000-8000-000000000002';
const firstSubscriptionId = '00000000-0000-4000-8000-000000000003';
const secondSubscriptionId = '00000000-0000-4000-8000-000000000004';

void test('reader maps one set-oriented query into stable reference and label order', async () => {
  let queryCount = 0;
  const transaction = {
    $queryRaw: (query: Readonly<{ strings: readonly string[]; values: readonly unknown[] }>) => {
      queryCount += 1;
      const sql = query.strings.join('?').replaceAll(/\s+/gu, ' ');
      assert.match(sql, /WITH requested/u);
      assert.match(sql, /JOIN subscriptions s/u);
      assert.match(sql, /s\.vendor_id=\?::uuid/u);
      assert.match(sql, /s\.household_id=\?::uuid/u);
      assert.match(sql, /s\.deleted_at IS NULL/u);
      assert.match(sql, /JOIN products p ON p\.vendor_id=r\.vendor_id AND p\.id=r\.product_id/u);
      assert.match(sql, /JOIN delivery_slots d ON d\.vendor_id=r\.vendor_id AND d\.id=r\.delivery_slot_id/u);
      assert.match(sql, /daterange\(r\.effective_from,r\.effective_to,'\[\)'\)/u);
      assert.match(sql, /r\.delivery_slot_id=requested\.delivery_slot_id/u);
      assert.match(sql, /ORDER BY "referenceId","subscriptionId","productId","deliverySlotId"/u);
      assert.ok(query.values.includes(vendorId));
      assert.ok(query.values.includes(householdId));
      return Promise.resolve([
        {
          referenceId: 'revision-b', subscriptionId: secondSubscriptionId,
          productId: '00000000-0000-4000-8000-000000000020', productName: 'Cow milk',
          deliverySlotId: '00000000-0000-4000-8000-000000000030', deliverySlotName: 'Morning',
        },
        {
          referenceId: 'revision-a', subscriptionId: firstSubscriptionId,
          productId: '00000000-0000-4000-8000-000000000011', productName: 'Buffalo milk',
          deliverySlotId: '00000000-0000-4000-8000-000000000031', deliverySlotName: 'Evening',
        },
        {
          referenceId: 'revision-a', subscriptionId: firstSubscriptionId,
          productId: '00000000-0000-4000-8000-000000000010', productName: 'Cow milk',
          deliverySlotId: '00000000-0000-4000-8000-000000000030', deliverySlotName: 'Morning',
        },
      ]);
    },
  } as unknown as Prisma.TransactionClient;

  const result = await new PrismaSubscriptionLabelReader().read(
    wrapPrismaTransaction(transaction),
    {
      vendorId,
      householdId,
      references: [
        { kind: 'range', referenceId: 'revision-a', subscriptionId: firstSubscriptionId, startDate: '2030-01-01', endDate: '2030-01-31' },
        { kind: 'occurrence', referenceId: 'revision-b', subscriptionId: secondSubscriptionId, serviceDate: '2030-01-10', deliverySlotId: '00000000-0000-4000-8000-000000000030' },
      ],
    },
  );

  assert.equal(queryCount, 1);
  assert.deepEqual(result, [
    {
      referenceId: 'revision-a', subscriptionId: firstSubscriptionId,
      productId: '00000000-0000-4000-8000-000000000010', productName: 'Cow milk',
      deliverySlotId: '00000000-0000-4000-8000-000000000030', deliverySlotName: 'Morning',
    },
    {
      referenceId: 'revision-a', subscriptionId: firstSubscriptionId,
      productId: '00000000-0000-4000-8000-000000000011', productName: 'Buffalo milk',
      deliverySlotId: '00000000-0000-4000-8000-000000000031', deliverySlotName: 'Evening',
    },
    {
      referenceId: 'revision-b', subscriptionId: secondSubscriptionId,
      productId: '00000000-0000-4000-8000-000000000020', productName: 'Cow milk',
      deliverySlotId: '00000000-0000-4000-8000-000000000030', deliverySlotName: 'Morning',
    },
  ]);
});

void test('empty references short-circuit without querying', async () => {
  let queryCount = 0;
  const transaction = {
    $queryRaw: () => { queryCount += 1; return Promise.resolve([]); },
  } as unknown as Prisma.TransactionClient;

  const result = await new PrismaSubscriptionLabelReader().read(
    wrapPrismaTransaction(transaction),
    { vendorId, references: [] },
  );

  assert.deepEqual(result, []);
  assert.equal(queryCount, 0);
});
