import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { PrismaSchedulingVendorService } from '../src/vendors/infrastructure/prisma-scheduling-vendor.service.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const service = new PrismaSchedulingVendorService(prisma);

const vendorIds = {
  activeNewest: '70000000-0000-4000-8000-000000000001',
  activeTie: '70000000-0000-4000-8000-000000000002',
  trialTie: '70000000-0000-4000-8000-000000000003',
  suspended: '70000000-0000-4000-8000-000000000004',
  deleted: '70000000-0000-4000-8000-000000000005',
  onboarding: '70000000-0000-4000-8000-000000000006',
} as const;

test.before(async () => {
  const fixtures = [
    [vendorIds.activeNewest, 'active', 'Asia/Kolkata', '2030-01-03T00:00:00.000Z', null],
    [vendorIds.activeTie, 'active', 'Europe/London', '2030-01-02T00:00:00.000Z', null],
    [vendorIds.trialTie, 'trial', 'America/New_York', '2030-01-02T00:00:00.000Z', null],
    [vendorIds.suspended, 'suspended', 'Asia/Tokyo', '2030-01-04T00:00:00.000Z', null],
    [vendorIds.deleted, 'active', 'Australia/Sydney', '2030-01-05T00:00:00.000Z', '2030-01-06T00:00:00.000Z'],
    [vendorIds.onboarding, 'onboarding', 'Europe/Paris', '2030-01-06T00:00:00.000Z', null],
  ] as const;

  for (const [id, status, timezone, createdAt, deletedAt] of fixtures) {
    await owner.query(
      `INSERT INTO vendors
         (id,code,legal_name,display_name,status,timezone,currency,
          skip_cutoff_minutes,billing_day,deleted_at,created_at,updated_at)
       VALUES ($1,$2,$2,$2,$3,$4,'INR',0,1,$5,$6,$6)`,
      [id, `scheduling-${id}`, status, timezone, deletedAt, createdAt],
    );
  }
});

test.after(async () => {
  await owner.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [Object.values(vendorIds)]);
  await Promise.all([owner.end(), prisma.$disconnect()]);
});

void test('pages only nondeleted trial and active vendors in stable descending order', async () => {
  const first = await service.listEligible({ limit: 2 });

  assert.deepEqual(first.items, [
    { id: vendorIds.activeNewest, timezone: 'Asia/Kolkata' },
    { id: vendorIds.trialTie, timezone: 'America/New_York' },
  ]);
  assert.equal(typeof first.nextCursor, 'string');
  assert.doesNotMatch(first.nextCursor!, /2030|70000000/);

  const second = await service.listEligible({ cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second, {
    items: [{ id: vendorIds.activeTie, timezone: 'Europe/London' }],
  });
});

void test('rechecks current eligibility only inside the matching tenant transaction', async () => {
  assert.deepEqual(
    await transactions.run(vendorIds.activeNewest, (tx) =>
      service.findEligible(tx, vendorIds.activeNewest)),
    { id: vendorIds.activeNewest, timezone: 'Asia/Kolkata' },
  );
  assert.equal(
    await transactions.run(vendorIds.activeNewest, (tx) =>
      service.findEligible(tx, vendorIds.activeTie)),
    null,
  );
  assert.equal(
    await transactions.run(vendorIds.suspended, (tx) =>
      service.findEligible(tx, vendorIds.suspended)),
    null,
  );
  assert.equal(
    await transactions.run(vendorIds.deleted, (tx) =>
      service.findEligible(tx, vendorIds.deleted)),
    null,
  );

  assert.deepEqual(
    await transactions.run(vendorIds.trialTie, (tx) =>
      service.findEligible(tx, vendorIds.trialTie)),
    { id: vendorIds.trialTie, timezone: 'America/New_York' },
  );

  await owner.query("UPDATE vendors SET timezone='Europe/Berlin' WHERE id=$1", [vendorIds.activeNewest]);
  assert.deepEqual(
    await transactions.run(vendorIds.activeNewest, (tx) =>
      service.findEligible(tx, vendorIds.activeNewest)),
    { id: vendorIds.activeNewest, timezone: 'Europe/Berlin' },
  );

  await owner.query("UPDATE vendors SET status='suspended' WHERE id=$1", [vendorIds.activeNewest]);
  assert.equal(
    await transactions.run(vendorIds.activeNewest, (tx) =>
      service.findEligible(tx, vendorIds.activeNewest)),
    null,
  );
});
