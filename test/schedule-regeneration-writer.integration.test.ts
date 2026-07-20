import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { PrismaAuditWriter } from '../src/audit/infrastructure/prisma-audit.writer.js';
import { unwrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaScheduleRegenerationWriter } from '../src/schedule-coordination/infrastructure/prisma-schedule-regeneration-writer.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const writer = new PrismaScheduleRegenerationWriter();
const audits = new PrismaAuditWriter();
test.after(() => Promise.all([owner.end(), prisma.$disconnect()]));

void test('configuration regeneration coalesces open work, replaces terminal work, and rolls back with configuration and audit', async () => {
  const vendorId = randomUUID();
  const userId = randomUUID();
  const auditId = randomUUID();
  const dates = ['2030-01-01', '2030-01-02', '2030-01-03', '2030-01-04'];
  await owner.query("INSERT INTO users(id,display_name,updated_at) VALUES($1,'Config actor',now())", [userId]);
  await owner.query("INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,'Config vendor','Before','active','UTC','INR',0,1,now())", [vendorId, `config-${vendorId}`]);

  try {
    await transactions.run(vendorId, (tx) => writer.write(tx, vendorId, '2030-01-01', dates, userId));
    await owner.query("UPDATE schedule_generation_runs SET status='running',attempt_count=1,available_at='2029-12-31T23:59:00Z',lease_token=$1,claimed_at='2030-01-01T00:00:00Z',lease_expires_at='2030-01-01T00:01:00Z',started_at='2030-01-01T00:00:00Z',updated_at=now() WHERE vendor_id=$2 AND service_date=$3", [randomUUID(), vendorId, dates[1]]);
    await owner.query("UPDATE schedule_generation_runs SET status='retry_wait',attempt_count=1,available_at='2030-01-01T00:05:00Z',started_at=now(),failure_code='RETRYABLE',failure_message='Retry safely',updated_at=now() WHERE vendor_id=$1 AND service_date=$2", [vendorId, dates[2]]);
    await owner.query("UPDATE schedule_generation_runs SET status='succeeded',attempt_count=1,started_at=now(),finished_at=now(),created_count=0,existing_count=0,updated_count=0,cancelled_count=0,missing_price_count=0,updated_at=now() WHERE vendor_id=$1 AND service_date=$2", [vendorId, dates[3]]);
    const queuedAvailableAt = (await owner.query<{ available_at: Date }>(
      'SELECT available_at FROM schedule_generation_runs WHERE vendor_id=$1 AND service_date=$2',
      [vendorId, dates[0]],
    )).rows[0].available_at;

    await transactions.run(vendorId, (tx) => writer.write(tx, vendorId, '2030-01-01', dates, userId));
    const rows = await owner.query<{ service_date: string; status: string; count: string }>(
      `SELECT service_date::text,status,count(*)::text FROM schedule_generation_runs
       WHERE vendor_id=$1 GROUP BY service_date,status ORDER BY service_date,status`,
      [vendorId],
    );
    assert.deepEqual(rows.rows, [
      { service_date: dates[0], status: 'queued', count: '1' },
      { service_date: dates[1], status: 'running', count: '1' },
      { service_date: dates[2], status: 'retry_wait', count: '1' },
      { service_date: dates[3], status: 'queued', count: '1' },
      { service_date: dates[3], status: 'succeeded', count: '1' },
    ]);
    const coalesced = await owner.query<{ service_date: string; invalidated: boolean | null; available_at: Date }>(
      `SELECT service_date::text,available_at>claimed_at AS invalidated,available_at
       FROM schedule_generation_runs WHERE vendor_id=$1 AND service_date IN ($2,$3,$4)
       ORDER BY service_date`,
      [vendorId, dates[0], dates[1], dates[2]],
    );
    assert.equal(coalesced.rows[0]?.available_at.toISOString(), queuedAvailableAt.toISOString());
    assert.equal(coalesced.rows[1]?.invalidated, true);
    assert.equal(coalesced.rows[2]?.available_at.toISOString(), '2030-01-01T00:05:00.000Z');

    await assert.rejects(transactions.run(vendorId, async (tx) => {
      await unwrapPrismaTransaction(tx).vendor.update({ where: { id: vendorId }, data: { displayName: 'Rolled back' } });
      await audits.append(tx, { id: auditId, vendorId, actorUserId: userId, action: 'vendor.updated', entityType: 'vendor', entityId: vendorId, correlationId: randomUUID() });
      await writer.write(tx, vendorId, '2030-01-01', ['2030-01-05'], randomUUID());
    }), /foreign key constraint/u);

    assert.equal((await owner.query<{ display_name: string }>('SELECT display_name FROM vendors WHERE id=$1', [vendorId])).rows[0]?.display_name, 'Before');
    assert.equal((await owner.query('SELECT 1 FROM audit_events WHERE id=$1', [auditId])).rowCount, 0);
    assert.equal((await owner.query('SELECT 1 FROM schedule_generation_runs WHERE vendor_id=$1 AND service_date=$2', [vendorId, '2030-01-05'])).rowCount, 0);
  } finally {
    await owner.query('DELETE FROM audit_events WHERE vendor_id=$1', [vendorId]);
    await owner.query('DELETE FROM schedule_generation_runs WHERE vendor_id=$1', [vendorId]);
    await owner.query('DELETE FROM vendors WHERE id=$1', [vendorId]);
    await owner.query('DELETE FROM users WHERE id=$1', [userId]);
  }
});
