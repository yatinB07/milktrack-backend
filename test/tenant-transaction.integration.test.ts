import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import { ApplicationError } from '../src/common/errors/application.error.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { PrismaTenantTransactionRunner } from '../src/database/tenant-transaction.runner.js';

const ownerPool = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});

void test('tenant transaction rejects a missing or malformed vendor before starting', async () => {
  const prisma = new PrismaService();
  const runner = new PrismaTenantTransactionRunner(prisma);

  try {
    for (const vendorId of ['', 'broken']) {
      assert.throws(
        () => runner.run(vendorId, () => Promise.resolve(undefined)),
        (error: unknown) =>
          error instanceof ApplicationError && error.code === 'INVALID_TENANT',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
});

void test('tenant transaction exposes only the selected vendor and keeps context transaction-local', async () => {
  const vendorIds = [randomUUID(), randomUUID()];
  const userIds = [randomUUID(), randomUUID()];
  const membershipIds = [randomUUID(), randomUUID()];
  const prisma = new PrismaService();
  const runner = new PrismaTenantTransactionRunner(prisma);

  await ownerPool.query(
    `INSERT INTO vendors
      (id, code, legal_name, display_name, timezone, currency, skip_cutoff_minutes, billing_day, updated_at)
     VALUES ($1, $2, 'Vendor A', 'Vendor A', 'Asia/Kolkata', 'INR', 0, 1, now()),
            ($3, $4, 'Vendor B', 'Vendor B', 'Asia/Kolkata', 'INR', 0, 1, now())`,
    [vendorIds[0], `test-${vendorIds[0]}`, vendorIds[1], `test-${vendorIds[1]}`],
  );
  await ownerPool.query(
    `INSERT INTO users (id, display_name, updated_at)
     VALUES ($1, 'Owner A', now()), ($2, 'Owner B', now())`,
    userIds,
  );
  await ownerPool.query(
    `INSERT INTO vendor_memberships
      (id, vendor_id, user_id, role, status, joined_at, updated_at)
     VALUES ($1, $2, $3, 'vendor_owner', 'active', now(), now()),
            ($4, $5, $6, 'vendor_owner', 'active', now(), now())`,
    [membershipIds[0], vendorIds[0], userIds[0], membershipIds[1], vendorIds[1], userIds[1]],
  );

  try {
    const result = await runner.run(vendorIds[0], async (tx) => ({
      memberships: await tx.vendorMembership.findMany(),
      setting: await tx.$queryRaw<Array<{ vendor_id: string }>>`
        SELECT current_setting('app.vendor_id', true) AS vendor_id
      `,
    }));
    const freshConnection = await ownerPool.query<{ vendor_id: string | null }>(
      "SELECT NULLIF(current_setting('app.vendor_id', true), '') AS vendor_id",
    );

    assert.deepEqual(
      result.memberships.map((membership) => membership.vendorId),
      [vendorIds[0]],
    );
    assert.equal(result.setting[0]?.vendor_id, vendorIds[0]);
    assert.equal(freshConnection.rows[0]?.vendor_id, null);
  } finally {
    await prisma.$disconnect();
    await ownerPool.query(
      'DELETE FROM vendor_memberships WHERE id = ANY($1::uuid[])',
      [membershipIds],
    );
    await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    await ownerPool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [vendorIds]);
    await ownerPool.end();
  }
});
