import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { PrismaScheduleRegenerationWriter } from '../src/schedule-coordination/infrastructure/prisma-schedule-regeneration-writer.js';
import { PrismaScheduleGenerationRunStore } from '../src/scheduling/infrastructure/prisma-schedule-generation-run.store.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const store = new PrismaScheduleGenerationRunStore();
const regeneration = new PrismaScheduleRegenerationWriter();
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

void test('marked terminal configuration failures atomically queue one successor while unmarked and retryable failures do not', async () => {
  const vendorId = await fixture('configuration-failure-invalidation');
  const userId = randomUUID();
  const now = new Date('2030-01-01T00:00:00.000Z');
  await owner.query("INSERT INTO users(id,display_name,updated_at) VALUES($1,'Configuration actor',now())", [userId]);
  try {
    for (const [serviceDate, retryable, initialStatus] of [
      ['2030-01-02', false, 'queued'],
      ['2030-01-03', true, 'retry_wait'],
    ] as const) {
      const id = randomUUID();
      if (initialStatus === 'queued') {
        await owner.query(
          `INSERT INTO schedule_generation_runs(id,vendor_id,trigger,trigger_local_date,service_date,requested_by_user_id,updated_at)
           VALUES($1,$2,'configuration_change','2030-01-01',$3,$4,now())`,
          [id, vendorId, serviceDate, userId],
        );
      } else {
        await owner.query(
          `INSERT INTO schedule_generation_runs(
             id,vendor_id,trigger,trigger_local_date,service_date,status,attempt_count,available_at,
             started_at,failure_code,failure_message,requested_by_user_id,updated_at)
           VALUES($1,$2,'configuration_change','2030-01-01',$3,'retry_wait',4,$5,
             '2029-12-31T23:00:00Z','TEMPORARY','Retry safely',$4,now())`,
          [id, vendorId, serviceDate, userId, now],
        );
      }
      const claim = await transactions.run(vendorId, (transaction) => store.claimNext(transaction, {
        vendorId, leaseToken: randomUUID(), now,
      }));
      assert.equal(claim?.id, id);
      await transactions.run(vendorId, (transaction) => regeneration.write(
        transaction, vendorId, '2030-01-01', [serviceDate], userId,
      ));
      const failed = await transactions.run(vendorId, (transaction) => store.fail(transaction, {
        fence: claim, code: 'TERMINAL', message: 'Failed safely', retryable, failedAt: now,
      }));
      assert.equal(failed?.status, 'failed');
      const rows = await owner.query<{ status: string; attempt_count: number }>(
        `SELECT status,attempt_count FROM schedule_generation_runs
         WHERE vendor_id=$1 AND service_date=$2 ORDER BY attempt_count DESC`,
        [vendorId, serviceDate],
      );
      assert.deepEqual(rows.rows, [
        { status: 'failed', attempt_count: initialStatus === 'queued' ? 1 : 5 },
        { status: 'queued', attempt_count: 0 },
      ]);
      await owner.query('DELETE FROM schedule_generation_runs WHERE vendor_id=$1 AND service_date=$2', [vendorId, serviceDate]);
    }

    const unmarkedDate = '2030-01-04';
    const unmarkedId = randomUUID();
    await owner.query(
      `INSERT INTO schedule_generation_runs(id,vendor_id,trigger,trigger_local_date,service_date,requested_by_user_id,updated_at)
       VALUES($1,$2,'configuration_change','2030-01-01',$3,$4,now())`,
      [unmarkedId, vendorId, unmarkedDate, userId],
    );
    const unmarked = await transactions.run(vendorId, (transaction) => store.claimNext(transaction, {
      vendorId, leaseToken: randomUUID(), now,
    }));
    assert.equal(unmarked?.id, unmarkedId);
    await transactions.run(vendorId, (transaction) => store.fail(transaction, {
      fence: unmarked, code: 'TERMINAL', message: 'Failed safely', retryable: false, failedAt: now,
    }));
    assert.deepEqual((await owner.query<{ status: string }>(
      'SELECT status FROM schedule_generation_runs WHERE vendor_id=$1 AND service_date=$2',
      [vendorId, unmarkedDate],
    )).rows, [{ status: 'failed' }]);

    const retryDate = '2030-01-05';
    const retryId = randomUUID();
    await owner.query(
      `INSERT INTO schedule_generation_runs(id,vendor_id,trigger,trigger_local_date,service_date,requested_by_user_id,updated_at)
       VALUES($1,$2,'configuration_change','2030-01-01',$3,$4,now())`,
      [retryId, vendorId, retryDate, userId],
    );
    const retryClaim = await transactions.run(vendorId, (transaction) => store.claimNext(transaction, {
      vendorId, leaseToken: randomUUID(), now,
    }));
    assert.ok(retryClaim);
    await transactions.run(vendorId, (transaction) => regeneration.write(
      transaction, vendorId, '2030-01-01', [retryDate], userId,
    ));
    const retry = await transactions.run(vendorId, (transaction) => store.fail(transaction, {
      fence: retryClaim, code: 'TEMPORARY', message: 'Retry safely', retryable: true, failedAt: now,
    }));
    assert.equal(retry?.status, 'retry_wait');
    assert.deepEqual((await owner.query<{ status: string }>(
      'SELECT status FROM schedule_generation_runs WHERE vendor_id=$1 AND service_date=$2',
      [vendorId, retryDate],
    )).rows, [{ status: 'retry_wait' }]);
  } finally {
    await cleanup(vendorId);
    await owner.query('DELETE FROM users WHERE id=$1', [userId]);
  }
});

void test('marked successful configuration processing atomically queues one successor', async () => {
  const vendorId = await fixture('configuration-success-invalidation');
  const userId = randomUUID();
  const id = randomUUID();
  const serviceDate = '2030-01-02';
  const now = new Date('2030-01-01T00:00:00.000Z');
  await owner.query("INSERT INTO users(id,display_name,updated_at) VALUES($1,'Configuration actor',now())", [userId]);
  await owner.query(
    `INSERT INTO schedule_generation_runs(id,vendor_id,trigger,trigger_local_date,service_date,requested_by_user_id,updated_at)
     VALUES($1,$2,'configuration_change','2030-01-01',$3,$4,now())`,
    [id, vendorId, serviceDate, userId],
  );
  try {
    const claim = await transactions.run(vendorId, (transaction) => store.claimNext(transaction, {
      vendorId, leaseToken: randomUUID(), now,
    }));
    assert.ok(claim);
    await transactions.run(vendorId, (transaction) => regeneration.write(
      transaction, vendorId, '2030-01-01', [serviceDate], userId,
    ));
    const succeeded = await transactions.run(vendorId, (transaction) => store.succeed(transaction, {
      fence: claim,
      counts: { created: 1, existing: 0, updated: 0, cancelled: 0, missingPrice: 0 },
      finishedAt: now,
    }));
    assert.equal(succeeded?.status, 'succeeded');
    assert.deepEqual((await owner.query<{ status: string; attempt_count: number }>(
      `SELECT status,attempt_count FROM schedule_generation_runs
       WHERE vendor_id=$1 AND service_date=$2 ORDER BY attempt_count DESC`,
      [vendorId, serviceDate],
    )).rows, [
      { status: 'succeeded', attempt_count: 1 },
      { status: 'queued', attempt_count: 0 },
    ]);
  } finally {
    await cleanup(vendorId);
    await owner.query('DELETE FROM users WHERE id=$1', [userId]);
  }
});

void test('an expired final attempt becomes terminal before other work is claimed', async () => {
  const vendorId = await fixture('expired-final-attempt');
  const userId = randomUUID();
  const expiredId = randomUUID();
  const expiredLeaseToken = randomUUID();
  const now = new Date('2030-01-01T00:02:00.000Z');
  await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [
    userId,
    'Expired run requester',
  ]);
  await owner.query(
    `INSERT INTO schedule_generation_runs (
       id,vendor_id,trigger,trigger_local_date,service_date,status,attempt_count,max_attempts,
       lease_token,claimed_at,lease_expires_at,started_at,requested_by_user_id,updated_at
     ) VALUES (
       $1,$2,'configuration_change','2030-01-01','2030-01-02','running',5,5,
       $3,'2030-01-01T00:00:00Z','2030-01-01T00:01:00Z','2030-01-01T00:00:00Z',$4,now()
     )`,
    [expiredId, vendorId, expiredLeaseToken, userId],
  );
  try {
    await transactions.run(vendorId, (transaction) => regeneration.write(
      transaction, vendorId, '2030-01-01', ['2030-01-02'], userId,
    ));
    const claimed = await transactions.run(vendorId, (transaction) => store.claimNext(transaction, {
      vendorId,
      leaseToken: randomUUID(),
      now,
    }));
    assert.equal(claimed, null);
    assert.deepEqual((await owner.query(
      `SELECT status,failure_code,failure_message,finished_at,lease_token,claimed_at,lease_expires_at
       FROM schedule_generation_runs WHERE id=$1`,
      [expiredId],
    )).rows, [{
      status: 'failed',
      failure_code: 'LEASE_EXPIRED',
      failure_message: 'Schedule generation lease expired after final attempt',
      finished_at: now,
      lease_token: null,
      claimed_at: null,
      lease_expires_at: null,
    }]);
    assert.deepEqual((await owner.query<{ status: string; attempt_count: number }>(
      `SELECT status,attempt_count FROM schedule_generation_runs
       WHERE vendor_id=$1 AND service_date='2030-01-02' ORDER BY attempt_count DESC`,
      [vendorId],
    )).rows, [
      { status: 'failed', attempt_count: 5 },
      { status: 'queued', attempt_count: 0 },
    ]);
    assert.equal(await transactions.run(vendorId, (transaction) => store.renew(transaction, {
      fence: { id: expiredId, leaseToken: expiredLeaseToken, attempt: 5 },
      now,
    })), false);
    assert.equal(await transactions.run(vendorId, (transaction) => store.succeed(transaction, {
      fence: { id: expiredId, leaseToken: expiredLeaseToken, attempt: 5 },
      counts: { created: 0, existing: 0, updated: 0, cancelled: 0, missingPrice: 0 },
      finishedAt: now,
    })), null);
    const successor = await transactions.run(vendorId, (transaction) => store.claimNext(transaction, {
      vendorId,
      leaseToken: randomUUID(),
      now: new Date(now.getTime() + 1),
    }));
    assert.equal(successor?.trigger, 'configuration_change');
    assert.equal(successor?.serviceDate, '2030-01-02');
    assert.notEqual(successor?.id, expiredId);
  } finally {
    await cleanup(vendorId);
    await owner.query('DELETE FROM users WHERE id=$1', [userId]);
  }
});
