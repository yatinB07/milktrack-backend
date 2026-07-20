import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { PrismaScheduleGenerationRunStore } from '../src/scheduling/infrastructure/prisma-schedule-generation-run.store.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const store = new PrismaScheduleGenerationRunStore();
test.after(() => Promise.all([owner.end(), prisma.$disconnect()]));

async function fixture(label: string) {
  const vendorId = randomUUID();
  await owner.query(
    `INSERT INTO vendors
       (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
     VALUES($1,$2,$3,$3,'active','Asia/Kolkata','INR',0,1,now())`,
    [vendorId, `run-store-${vendorId}`, `Run store ${label}`],
  );
  return vendorId;
}

async function queued(vendorId: string, serviceDate = '2030-01-02') {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO schedule_generation_runs
       (id,vendor_id,trigger,trigger_local_date,service_date,updated_at)
     VALUES($1,$2,'automatic','2030-01-01',$3,now())`,
    [id, vendorId, serviceDate],
  );
  return id;
}

async function cleanup(vendorId: string) {
  await owner.query('DELETE FROM schedule_generation_runs WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM vendors WHERE id=$1', [vendorId]);
}

void test('claimNext skips a row locked by another worker', async () => {
  const vendorId = await fixture('skip-locked');
  await queued(vendorId);
  let claimed!: () => void;
  let release!: () => void;
  const claimedPromise = new Promise<void>((resolve) => { claimed = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  try {
    const first = transactions.run(vendorId, async (transaction) => {
      const result = await store.claimNext(transaction, {
        vendorId, leaseToken: randomUUID(), now: new Date('2030-01-01T00:00:00.000Z'),
      });
      claimed();
      await releasePromise;
      return result;
    });
    await claimedPromise;

    const second = await transactions.run(vendorId, (transaction) => store.claimNext(transaction, {
      vendorId, leaseToken: randomUUID(), now: new Date('2030-01-01T00:00:00.000Z'),
    }));
    assert.equal(second, null);
    release();
    assert.equal((await first)?.attempt, 1);
  } finally {
    release();
    await cleanup(vendorId);
  }
});

void test('renewal extends a lease and reclaim fences the stale worker', async () => {
  const vendorId = await fixture('fence');
  await queued(vendorId);
  const startedAt = new Date('2030-01-01T00:00:00.000Z');
  try {
    const first = await transactions.run(vendorId, (transaction) => store.claimNext(transaction, {
      vendorId, leaseToken: randomUUID(), now: startedAt,
    }));
    assert.ok(first);
    assert.equal(await transactions.run(vendorId, (transaction) => store.renew(transaction, {
      fence: first, now: new Date('2030-01-01T00:00:10.000Z'),
    })), true);
    assert.equal(await transactions.run(vendorId, (transaction) => store.claimNext(transaction, {
      vendorId, leaseToken: randomUUID(), now: new Date('2030-01-01T00:01:01.000Z'),
    })), null);
    assert.equal(await transactions.run(vendorId, (transaction) => store.renew(transaction, {
      fence: first, now: new Date('2030-01-01T00:01:11.000Z'),
    })), false);

    const reclaimed = await transactions.run(vendorId, (transaction) => store.claimNext(transaction, {
      vendorId, leaseToken: randomUUID(), now: new Date('2030-01-01T00:01:11.000Z'),
    }));
    assert.ok(reclaimed);
    assert.equal(reclaimed.attempt, 2);
    assert.notEqual(reclaimed.leaseToken, first.leaseToken);
    assert.equal(await transactions.run(vendorId, (transaction) => store.renew(transaction, {
      fence: first, now: new Date('2030-01-01T00:01:12.000Z'),
    })), false);
    assert.equal(await transactions.run(vendorId, (transaction) => store.succeed(transaction, {
      fence: first,
      counts: { created: 1, existing: 0, updated: 0, cancelled: 0, missingPrice: 0 },
      finishedAt: new Date('2030-01-01T00:01:12.000Z'),
    })), null);
    const succeeded = await transactions.run(vendorId, (transaction) => store.succeed(transaction, {
      fence: reclaimed,
      counts: { created: 1, existing: 0, updated: 0, cancelled: 0, missingPrice: 0 },
      finishedAt: new Date('2030-01-01T00:01:12.000Z'),
    }));
    assert.equal(succeeded?.status, 'succeeded');
  } finally { await cleanup(vendorId); }
});

void test('retryable failures persist bounded backoff and exhaust at max attempts', async () => {
  const vendorId = await fixture('retry');
  await queued(vendorId);
  let now = new Date('2030-01-01T00:00:00.000Z');
  try {
    for (const [index, seconds] of [5, 10, 20, 40].entries()) {
      const claim = await transactions.run(vendorId, (transaction) => store.claimNext(transaction, {
        vendorId, leaseToken: randomUUID(), now,
      }));
      assert.equal(claim?.attempt, index + 1);
      const failed = await transactions.run(vendorId, (transaction) => store.fail(transaction, {
        fence: claim, code: ' TEMPORARY ', message: ' Retry safely ', retryable: true, failedAt: now,
      }));
      assert.equal(failed?.status, 'retry_wait');
      now = new Date(now.getTime() + seconds * 1_000);
      assert.equal(failed?.availableAt.toISOString(), now.toISOString());
    }
    const finalClaim = await transactions.run(vendorId, (transaction) => store.claimNext(transaction, {
      vendorId, leaseToken: randomUUID(), now,
    }));
    assert.equal(finalClaim?.attempt, 5);
    const exhausted = await transactions.run(vendorId, (transaction) => store.fail(transaction, {
      fence: finalClaim, code: 'TEMPORARY', message: 'Retry safely', retryable: true, failedAt: now,
    }));
    assert.equal(exhausted?.status, 'failed');
    assert.equal(exhausted?.finishedAt?.toISOString(), now.toISOString());
    assert.equal(await transactions.run(vendorId, (transaction) => store.claimNext(transaction, {
      vendorId, leaseToken: randomUUID(), now: new Date(now.getTime() + 60_000),
    })), null);
  } finally { await cleanup(vendorId); }
});
