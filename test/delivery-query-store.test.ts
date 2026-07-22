import assert from 'node:assert/strict';
import test from 'node:test';

import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaDeliveryStore } from '../src/delivery/infrastructure/prisma-delivery.store.js';

void test('vendor delivery query constrains household, route, agent, and stable service-date cursor', async () => {
  const vendorId = '00000000-0000-4000-8000-000000000001';
  const householdId = '00000000-0000-4000-8000-000000000002';
  const routeId = '00000000-0000-4000-8000-000000000003';
  const agentMembershipId = '00000000-0000-4000-8000-000000000004';
  let queryCount = 0;
  const transaction = {
    $queryRaw: (query: Readonly<{ strings: readonly string[]; values: readonly unknown[] }>) => {
      queryCount += 1;
      const sql = query.strings.join('?').replaceAll(/\s+/gu, ' ');
      assert.match(sql, /LEFT JOIN route_assignments a ON a\.vendor_id=d\.vendor_id AND a\.id=d\.route_assignment_id/u);
      assert.match(sql, /household_id=\?::uuid/u);
      assert.match(sql, /a\.route_id=\?::uuid/u);
      assert.match(sql, /a\.agent_membership_id=\?::uuid/u);
      assert.match(sql, /d\.service_date<\?::date OR \(d\.service_date=\?::date AND d\.id<\?::uuid\)/u);
      assert.match(sql, /ORDER BY d\.service_date DESC,d\.id DESC/u);
      assert.ok(query.values.includes(vendorId));
      assert.ok(query.values.includes(householdId));
      assert.ok(query.values.includes(routeId));
      assert.ok(query.values.includes(agentMembershipId));
      return Promise.resolve([]);
    },
  } as unknown as Prisma.TransactionClient;

  await new PrismaDeliveryStore().listVendor(wrapPrismaTransaction(transaction), {
    vendorId,
    householdId,
    routeId,
    agentMembershipId,
    cursor: Buffer.from(JSON.stringify(['2030-01-01T00:00:00.000Z', '00000000-0000-4000-8000-000000000005'])).toString('base64url'),
  });

  assert.equal(queryCount, 1);
});
