import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import { ApplicationError } from '../src/common/errors/application.error.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { PrismaTenantTransactionRunner } from '../src/database/tenant-transaction.runner.js';
import { PrismaAuditWriter } from '../src/audit/infrastructure/prisma-audit.writer.js';

const ownerPool = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});
const runtimePool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

test.after(() => Promise.all([ownerPool.end(), runtimePool.end()]));

void test('audit append commits and rolls back with its vendor transaction', async () => {
  const vendorId = randomUUID();
  const actorUserId = randomUUID();
  const committedAuditId = randomUUID();
  const rolledBackAuditId = randomUUID();
  const prisma = new PrismaService();
  const runner = new PrismaTenantTransactionRunner(prisma);
  const writer = new PrismaAuditWriter();

  await ownerPool.query(
    `INSERT INTO vendors
      (id, code, legal_name, display_name, timezone, currency, skip_cutoff_minutes, billing_day, updated_at)
     VALUES ($1, $2, 'Audit Vendor', 'Before', 'Asia/Kolkata', 'INR', 0, 1, now())`,
    [vendorId, `test-${vendorId}`],
  );

  try {
    await runner.run(vendorId, async (tx) => {
      await tx.vendor.update({
        where: { id: vendorId },
        data: { displayName: 'Committed' },
      });
      await writer.append(tx, {
        id: committedAuditId,
        vendorId,
        actorUserId,
        action: 'vendor.updated',
        entityType: 'vendor',
        entityId: vendorId,
        oldValue: { displayName: 'Before' },
        newValue: { displayName: 'Committed' },
        reason: 'integration test',
        correlationId: randomUUID(),
      });
    });

    await assert.rejects(
      runner.run(vendorId, async (tx) => {
        await tx.vendor.update({
          where: { id: vendorId },
          data: { displayName: 'Rolled Back' },
        });
        await writer.append(tx, {
          id: rolledBackAuditId,
          vendorId,
          actorUserId,
          action: 'vendor.updated',
          entityType: 'vendor',
          entityId: vendorId,
          newValue: { displayName: 'Rolled Back' },
          correlationId: randomUUID(),
        });
        throw new Error('rollback');
      }),
      /rollback/,
    );

    const vendor = await ownerPool.query<{ display_name: string }>(
      'SELECT display_name FROM vendors WHERE id = $1',
      [vendorId],
    );
    const audits = await ownerPool.query<{ id: string }>(
      'SELECT id FROM audit_events WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[committedAuditId, rolledBackAuditId]],
    );

    assert.equal(vendor.rows[0]?.display_name, 'Committed');
    assert.deepEqual(audits.rows, [{ id: committedAuditId }]);
  } finally {
    await prisma.$disconnect();
    await ownerPool.query('DELETE FROM audit_events WHERE id = ANY($1::uuid[])', [
      [committedAuditId, rolledBackAuditId],
    ]);
    await ownerPool.query('DELETE FROM vendors WHERE id = $1', [vendorId]);
  }
});

void test('runtime role cannot update or delete audit events', async () => {
  const auditId = randomUUID();
  await ownerPool.query(
    `INSERT INTO audit_events
      (id, actor_user_id, action, entity_type, entity_id, correlation_id)
     VALUES ($1, $2, 'test', 'vendor', $3, $4)`,
    [auditId, randomUUID(), randomUUID(), randomUUID()],
  );

  try {
    await assert.rejects(
      runtimePool.query('UPDATE audit_events SET action = $1 WHERE id = $2', [
        'changed',
        auditId,
      ]),
      /permission denied for table audit_events/,
    );
    await assert.rejects(
      runtimePool.query('DELETE FROM audit_events WHERE id = $1', [auditId]),
      /permission denied for table audit_events/,
    );
  } finally {
    await ownerPool.query('DELETE FROM audit_events WHERE id = $1', [auditId]);
  }
});

void test('audit append rejects prohibited keys nested inside arrays and objects', async () => {
  const auditId = randomUUID();
  const prisma = new PrismaService();
  const writer = new PrismaAuditWriter();

  try {
    await assert.rejects(
      prisma.$transaction((tx) =>
        writer.append(tx, {
          id: auditId,
          actorUserId: randomUUID(),
          action: 'test',
          entityType: 'vendor',
          entityId: randomUUID(),
          newValue: { changes: [{ metadata: { refreshToken: 'unsafe' } }] },
          correlationId: randomUUID(),
        }),
      ),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'AUDIT_SECRET_REJECTED' &&
        error.status === 500,
    );

    const audit = await ownerPool.query('SELECT id FROM audit_events WHERE id = $1', [
      auditId,
    ]);
    assert.equal(audit.rowCount, 0);
  } finally {
    await prisma.$disconnect();
    await ownerPool.query('DELETE FROM audit_events WHERE id = $1', [auditId]);
  }
});

void test('audit append rejects prohibited keys produced by JSON serialization', async () => {
  const auditId = randomUUID();
  const vendorId = randomUUID();
  const prisma = new PrismaService();
  const runner = new PrismaTenantTransactionRunner(prisma);
  const writer = new PrismaAuditWriter();

  await ownerPool.query(
    `INSERT INTO vendors
      (id, code, legal_name, display_name, timezone, currency, skip_cutoff_minutes, billing_day, updated_at)
     VALUES ($1, $2, 'Serialized Audit Vendor', 'Serialized Audit Vendor', 'Asia/Kolkata', 'INR', 0, 1, now())`,
    [vendorId, `test-${vendorId}`],
  );

  try {
    await assert.rejects(
      runner.run(vendorId, (tx) =>
        writer.append(tx, {
          id: auditId,
          vendorId,
          actorUserId: randomUUID(),
          action: 'test',
          entityType: 'vendor',
          entityId: randomUUID(),
          newValue: { toJSON: () => ({ password: 'unsafe' }) },
          correlationId: randomUUID(),
        }),
      ),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'AUDIT_SECRET_REJECTED',
    );
  } finally {
    await prisma.$disconnect();
    await ownerPool.query('DELETE FROM audit_events WHERE id = $1', [auditId]);
    await ownerPool.query('DELETE FROM vendors WHERE id = $1', [vendorId]);
  }
});
