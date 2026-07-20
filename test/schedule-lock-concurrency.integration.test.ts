import assert from 'node:assert/strict';
import test from 'node:test';

import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { PrismaScheduleDateLock } from '../src/schedule-coordination/infrastructure/prisma-schedule-date-lock.js';
import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';

const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const dates = new PrismaScheduleDateLock();
test.after(() => prisma.$disconnect());

void test('same vendor/date generators and mutations serialize without hanging', { timeout: 5000 }, async () => {
  const vendorId = '00000000-0000-4000-8000-000000000001';
  let releaseFirst!: () => void; const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstAcquired!: () => void; const firstAcquired = new Promise<void>((resolve) => { markFirstAcquired = resolve; });
  let secondEntered!: () => void; const entered = new Promise<void>((resolve) => { secondEntered = resolve; });
  let secondAcquired = false;
  const first = transactions.run(vendorId, async (tx) => {
    await dates.lock(tx, vendorId, ['2030-01-01']);
    markFirstAcquired();
    await release;
  });
  await firstAcquired;
  const second = transactions.run(vendorId, async (tx) => {
    secondEntered();
    await dates.lock(tx, vendorId, ['2030-01-01']);
    secondAcquired = true;
  });
  await entered;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(secondAcquired, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondAcquired, true);
});
