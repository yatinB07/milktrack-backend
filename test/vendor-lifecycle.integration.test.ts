import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import { AuditWriter } from '../src/audit/application/audit-writer.js';
import { PrismaAuditWriter } from '../src/audit/infrastructure/prisma-audit.writer.js';
import type { Actor } from '../src/common/context/request-context.js';
import { requestContextStore } from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { PrismaTenantTransactionRunner } from '../src/database/tenant-transaction.runner.js';
import { TransitionVendor } from '../src/vendors/application/transition-vendor.js';
import { PrismaVendorStore } from '../src/vendors/infrastructure/prisma-vendor.store.js';

const ownerPool = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});

const administrator: Actor = {
  userId: randomUUID(),
  sessionId: randomUUID(),
  displayName: 'Platform Administrator',
  authenticationMethod: 'administrator_mfa',
  platformRoles: ['platform_administrator'],
  memberships: [],
};

const execute = (
  operation: TransitionVendor,
  vendorId: string,
  overrides: Partial<{
    to: 'active' | 'suspended';
    reason: string;
    expectedVersion: number;
    actor: Actor;
  }> = {},
) =>
  requestContextStore.run(
    { correlationId: randomUUID(), actor: overrides.actor ?? administrator },
    () =>
      operation.execute(
        {
          vendorId,
          to: overrides.to ?? 'suspended',
          reason: overrides.reason ?? '  compliance review  ',
          expectedVersion: overrides.expectedVersion ?? 1,
        },
        overrides.actor ?? administrator,
      ),
  );

async function insertVendor(
  vendorId: string,
  status = 'active',
  deleted = false,
): Promise<void> {
  await ownerPool.query(
    `INSERT INTO vendors
      (id, code, legal_name, display_name, status, timezone, currency,
       skip_cutoff_minutes, billing_day, deleted_at, updated_at)
     VALUES ($1, $2, 'Lifecycle Vendor', 'Lifecycle Vendor', $3,
             'Asia/Kolkata', 'INR', 0, 1, $4, now())`,
    [vendorId, `test-${vendorId}`, status, deleted ? new Date() : null],
  );
}

async function cleanup(vendorId: string): Promise<void> {
  await ownerPool.query('DELETE FROM audit_events WHERE vendor_id = $1', [vendorId]);
  await ownerPool.query('DELETE FROM vendors WHERE id = $1', [vendorId]);
}

test.after(() => ownerPool.end());

void test('transition increments the version and appends one redacted audit event atomically', async () => {
  const vendorId = randomUUID();
  const prisma = new PrismaService();
  const operation = new TransitionVendor(
    new PrismaTenantTransactionRunner(prisma),
    new PrismaVendorStore(),
    new PrismaAuditWriter(),
  );
  await insertVendor(vendorId);

  try {
    const result = await execute(operation, vendorId);
    const vendor = await ownerPool.query<{ status: string; version: number }>(
      'SELECT status, version FROM vendors WHERE id = $1',
      [vendorId],
    );
    const audits = await ownerPool.query<{
      action: string;
      old_value: unknown;
      new_value: unknown;
      reason: string;
    }>(
      `SELECT action, old_value, new_value, reason
       FROM audit_events WHERE vendor_id = $1`,
      [vendorId],
    );

    assert.equal(result.status, 'suspended');
    assert.equal(result.version, 2);
    assert.deepEqual(vendor.rows, [{ status: 'suspended', version: 2 }]);
    assert.deepEqual(audits.rows, [
      {
        action: 'vendor.lifecycle_changed',
        old_value: { status: 'active' },
        new_value: { status: 'suspended' },
        reason: 'compliance review',
      },
    ]);
  } finally {
    await prisma.$disconnect();
    await cleanup(vendorId);
  }
});

void test('audit failure rolls back the vendor status and version', async () => {
  class FailingAuditWriter extends AuditWriter {
    append(): Promise<void> {
      return Promise.reject(new Error('forced audit failure'));
    }
  }

  const vendorId = randomUUID();
  const prisma = new PrismaService();
  const operation = new TransitionVendor(
    new PrismaTenantTransactionRunner(prisma),
    new PrismaVendorStore(),
    new FailingAuditWriter(),
  );
  await insertVendor(vendorId);

  try {
    await assert.rejects(execute(operation, vendorId), /forced audit failure/);
    const vendor = await ownerPool.query<{ status: string; version: number }>(
      'SELECT status, version FROM vendors WHERE id = $1',
      [vendorId],
    );
    assert.deepEqual(vendor.rows, [{ status: 'active', version: 1 }]);
  } finally {
    await prisma.$disconnect();
    await cleanup(vendorId);
  }
});

void test('transition requires platform administrator authority and a valid reason', async () => {
  const vendorId = randomUUID();
  const prisma = new PrismaService();
  const operation = new TransitionVendor(
    new PrismaTenantTransactionRunner(prisma),
    new PrismaVendorStore(),
    new PrismaAuditWriter(),
  );
  await insertVendor(vendorId);

  try {
    const productOwner: Actor = {
      userId: randomUUID(),
      sessionId: randomUUID(),
      displayName: 'Product Owner',
      authenticationMethod: 'administrator_mfa',
      platformRoles: ['product_owner'],
      memberships: [],
    };
    await assert.rejects(execute(operation, vendorId, { actor: productOwner }),
      (error: unknown) => error instanceof ApplicationError && error.code === 'FORBIDDEN');
    for (const reason of [' x ', 'x'.repeat(501)]) {
      await assert.rejects(execute(operation, vendorId, { reason }),
        (error: unknown) => error instanceof ApplicationError && error.code === 'INVALID_REASON');
    }
  } finally {
    await prisma.$disconnect();
    await cleanup(vendorId);
  }
});

void test('transition excludes deleted vendors and rejects stale versions', async () => {
  const vendorIds = [randomUUID(), randomUUID()];
  const prisma = new PrismaService();
  const operation = new TransitionVendor(
    new PrismaTenantTransactionRunner(prisma),
    new PrismaVendorStore(),
    new PrismaAuditWriter(),
  );
  await insertVendor(vendorIds[0], 'active', true);
  await insertVendor(vendorIds[1]);

  try {
    await assert.rejects(execute(operation, vendorIds[0]),
      (error: unknown) => error instanceof ApplicationError && error.code === 'VENDOR_NOT_FOUND');
    await assert.rejects(execute(operation, vendorIds[1], { expectedVersion: 2 }),
      (error: unknown) => error instanceof ApplicationError && error.code === 'VENDOR_STATE_CONFLICT');
  } finally {
    await prisma.$disconnect();
    await Promise.all(vendorIds.map(cleanup));
  }
});
