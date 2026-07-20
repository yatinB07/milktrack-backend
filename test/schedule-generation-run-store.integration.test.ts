import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { unwrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { PrismaScheduleDateLock } from '../src/schedule-coordination/infrastructure/prisma-schedule-date-lock.js';
import { PrismaScheduleRegenerationWriter } from '../src/schedule-coordination/infrastructure/prisma-schedule-regeneration-writer.js';
import { PrismaScheduleGenerationRunStore } from '../src/scheduling/infrastructure/prisma-schedule-generation-run.store.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const store = new PrismaScheduleGenerationRunStore();
const regeneration = new PrismaScheduleRegenerationWriter();
const scheduleDates = new PrismaScheduleDateLock();
test.after(() => Promise.all([owner.end(), prisma.$disconnect()]));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 3_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForDatabaseLock(
  waiterPid: number,
  blockerPid: number,
  advisory = false,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const activity = await owner.query<{
      wait_event_type: string | null;
      blocked_by_expected: boolean;
      advisory_wait: boolean;
    }>(
      `SELECT a.wait_event_type,$2::int=ANY(pg_blocking_pids($1)) AS blocked_by_expected,
         EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=$1 AND NOT l.granted AND l.locktype='advisory') AS advisory_wait
       FROM pg_stat_activity a WHERE a.pid=$1`,
      [waiterPid, blockerPid],
    );
    const row = activity.rows[0];
    if (row?.wait_event_type === 'Lock' && row.blocked_by_expected
      && (!advisory || row.advisory_wait)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`backend ${waiterPid} did not block behind backend ${blockerPid}`);
}

async function backendPid(transaction: Parameters<typeof unwrapPrismaTransaction>[0]) {
  const rows = await unwrapPrismaTransaction(transaction).$queryRaw<Array<{ pid: number }>>`
    SELECT pg_backend_pid() AS pid`;
  const row = rows[0];
  if (!row) throw new Error('transaction backend PID is unavailable');
  return row.pid;
}

async function boundDatabaseWait(transaction: Parameters<typeof unwrapPrismaTransaction>[0]) {
  const tx = unwrapPrismaTransaction(transaction);
  await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
  await tx.$executeRaw`SET LOCAL statement_timeout = '2500ms'`;
}

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

async function runningConfiguration(
  vendorId: string,
  userId: string,
  serviceDate: string,
  attempt = 1,
) {
  const id = randomUUID();
  const leaseToken = randomUUID();
  await owner.query(
    `INSERT INTO schedule_generation_runs(
       id,vendor_id,trigger,trigger_local_date,service_date,status,attempt_count,
       lease_token,claimed_at,lease_expires_at,started_at,requested_by_user_id,updated_at
     ) VALUES($1,$2,'configuration_change','2030-01-01',$3,'running',$4,$5,
       '2030-01-01T00:00:00Z','2030-01-01T00:01:00Z','2030-01-01T00:00:00Z',$6,now())`,
    [id, vendorId, serviceDate, attempt, leaseToken, userId],
  );
  return { id, vendorId, trigger: 'configuration_change' as const, triggerLocalDate: '2030-01-01',
    serviceDate, attempt, maxAttempts: 5, leaseToken, leaseExpiresAt: new Date('2030-01-01T00:01:00Z'),
    requestedByUserId: userId };
}

void test('automatic seeding inserts queued attempt-zero rows once and returns the inserted count', async () => {
  const vendorId = await fixture('automatic-seed');
  const now = new Date('2030-01-01T00:00:00.000Z');
  const input = {
    vendorId,
    triggerLocalDate: '2030-01-01',
    serviceDates: ['2030-01-01', '2030-01-02'],
    now,
  };
  try {
    assert.equal(await transactions.run(vendorId, (transaction) => store.seedAutomatic(
      transaction,
      input,
    )), 2);
    assert.equal(await transactions.run(vendorId, (transaction) => store.seedAutomatic(
      transaction,
      input,
    )), 0);
    assert.deepEqual((await owner.query<{
      trigger: string;
      trigger_local_date: string;
      service_date: string;
      status: string;
      attempt_count: number;
      max_attempts: number;
      requested_by_user_id: string | null;
      available_at: Date;
    }>(
      `SELECT trigger,trigger_local_date::text,service_date::text,status,attempt_count,
         max_attempts,requested_by_user_id,available_at
       FROM schedule_generation_runs WHERE vendor_id=$1 ORDER BY service_date`,
      [vendorId],
    )).rows, input.serviceDates.map((serviceDate) => ({
      trigger: 'automatic',
      trigger_local_date: input.triggerLocalDate,
      service_date: serviceDate,
      status: 'queued',
      attempt_count: 0,
      max_attempts: 5,
      requested_by_user_id: null,
      available_at: now,
    })));
  } finally {
    await cleanup(vendorId);
  }
});

void test('concurrent workers seed one seven-day horizon without duplicates', async () => {
  const vendorId = await fixture('concurrent-automatic-seed');
  const now = new Date('2030-01-01T00:00:00.000Z');
  const input = {
    vendorId,
    triggerLocalDate: '2030-01-01',
    serviceDates: Array.from({ length: 7 }, (_, index) => `2030-01-0${index + 1}`),
    now,
  };
  const blockerPid = deferred<number>();
  const waiterPid = deferred<number>();
  const release = deferred();
  try {
    const first = transactions.run(vendorId, async (transaction) => {
      const inserted = await store.seedAutomatic(transaction, input);
      blockerPid.resolve(await backendPid(transaction));
      await release.promise;
      return inserted;
    });
    const blockingPid = await blockerPid.promise;
    const second = transactions.run(vendorId, async (transaction) => {
      waiterPid.resolve(await backendPid(transaction));
      return store.seedAutomatic(transaction, input);
    });
    const waitingPid = await waiterPid.promise;
    await waitForDatabaseLock(waitingPid, blockingPid);
    release.resolve();
    const inserted = await Promise.all([first, second]);
    assert.deepEqual(inserted.sort((left, right) => left - right), [0, 7]);
    assert.deepEqual((await owner.query<{ service_date: string }>(
      `SELECT service_date::text FROM schedule_generation_runs
       WHERE vendor_id=$1 AND trigger='automatic' ORDER BY service_date`,
      [vendorId],
    )).rows.map(({ service_date }) => service_date), input.serviceDates);
  } finally {
    release.resolve();
    await cleanup(vendorId);
  }
});

void test('a next-day restart preserves the prior horizon and seeds its full catch-up horizon', async () => {
  const vendorId = await fixture('next-day-catch-up');
  const firstDates = Array.from({ length: 7 }, (_, index) => `2030-01-0${index + 1}`);
  const nextDates = Array.from({ length: 7 }, (_, index) => `2030-01-0${index + 2}`);
  try {
    assert.equal(await transactions.run(vendorId, (transaction) => store.seedAutomatic(transaction, {
      vendorId,
      triggerLocalDate: '2030-01-01',
      serviceDates: firstDates,
      now: new Date('2030-01-01T00:00:00.000Z'),
    })), 7);
    assert.equal(await transactions.run(vendorId, (transaction) => store.seedAutomatic(transaction, {
      vendorId,
      triggerLocalDate: '2030-01-02',
      serviceDates: nextDates,
      now: new Date('2030-01-02T00:00:00.000Z'),
    })), 7);
    assert.deepEqual((await owner.query<{ trigger_local_date: string; service_dates: string[] }>(
      `SELECT trigger_local_date::text,array_agg(service_date::text ORDER BY service_date) AS service_dates
       FROM schedule_generation_runs WHERE vendor_id=$1 AND trigger='automatic'
       GROUP BY trigger_local_date ORDER BY trigger_local_date`,
      [vendorId],
    )).rows, [
      { trigger_local_date: '2030-01-01', service_dates: firstDates },
      { trigger_local_date: '2030-01-02', service_dates: nextDates },
    ]);
  } finally {
    await cleanup(vendorId);
  }
});

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

void test('a committed writer marker is observed by blocked terminal failure and success transactions', { timeout: 10_000 }, async () => {
  for (const terminal of ['failed', 'succeeded'] as const) {
    const vendorId = await fixture(`writer-first-${terminal}`);
    const userId = randomUUID();
    const serviceDate = terminal === 'failed' ? '2030-01-06' : '2030-01-07';
    await owner.query("INSERT INTO users(id,display_name,updated_at) VALUES($1,'Interleaving actor',now())", [userId]);
    const claim = await runningConfiguration(vendorId, userId, serviceDate);
    const writerReady = deferred<number>();
    const releaseWriter = deferred();
    const terminalPid = deferred<number>();
    let writerTransaction: Promise<void> | undefined;
    let terminalTransaction: Promise<unknown> | undefined;
    try {
      writerTransaction = transactions.run(vendorId, async (transaction) => {
        await boundDatabaseWait(transaction);
        if (terminal === 'succeeded') await scheduleDates.lock(transaction, vendorId, [serviceDate]);
        await regeneration.write(transaction, vendorId, '2030-01-01', [serviceDate], userId);
        writerReady.resolve(await backendPid(transaction));
        await releaseWriter.promise;
      });
      const writerPid = await bounded(writerReady.promise, `${terminal} writer setup`);
      terminalTransaction = transactions.run(vendorId, async (transaction) => {
        await boundDatabaseWait(transaction);
        const pid = await backendPid(transaction);
        terminalPid.resolve(pid);
        if (terminal === 'succeeded') await scheduleDates.lock(transaction, vendorId, [serviceDate]);
        return terminal === 'failed'
          ? store.fail(transaction, {
            fence: claim, code: 'TERMINAL', message: 'Failed safely', retryable: false,
            failedAt: new Date('2030-01-01T00:00:30Z'),
          })
          : store.succeed(transaction, {
            fence: claim,
            counts: { created: 1, existing: 0, updated: 0, cancelled: 0, missingPrice: 0 },
            finishedAt: new Date('2030-01-01T00:00:30Z'),
          });
      });
      const pid = await bounded(terminalPid.promise, `${terminal} terminal start`);
      await waitForDatabaseLock(pid, writerPid, terminal === 'succeeded');
      releaseWriter.resolve();
      const [, result] = await bounded(
        Promise.all([writerTransaction, terminalTransaction]),
        `${terminal} interleaving`,
      );
      assert.equal((result as { status: string } | null)?.status, terminal);
      assert.deepEqual((await owner.query<{ status: string; count: string }>(
        `SELECT status,count(*)::text FROM schedule_generation_runs
         WHERE vendor_id=$1 AND service_date=$2 GROUP BY status ORDER BY status`,
        [vendorId, serviceDate],
      )).rows, [
        { status: terminal, count: '1' },
        { status: 'queued', count: '1' },
      ].sort((left, right) => left.status.localeCompare(right.status)));
      assert.equal((await owner.query(
        `SELECT 1 FROM schedule_generation_runs WHERE vendor_id=$1 AND service_date=$2
         AND trigger='configuration_change' AND status IN ('queued','running','retry_wait')`,
        [vendorId, serviceDate],
      )).rowCount, 1);
    } finally {
      releaseWriter.resolve();
      await bounded(
        Promise.allSettled([writerTransaction, terminalTransaction].filter((value) => value !== undefined)),
        `${terminal} teardown`,
      );
      await cleanup(vendorId);
      await owner.query('DELETE FROM users WHERE id=$1', [userId]);
    }
  }
});

void test('a writer blocked behind expired-final cleanup inserts exactly one successor after terminal commit', { timeout: 10_000 }, async () => {
  const vendorId = await fixture('expired-first-interleaving');
  const userId = randomUUID();
  const serviceDate = '2030-01-08';
  await owner.query("INSERT INTO users(id,display_name,updated_at) VALUES($1,'Expired interleaving actor',now())", [userId]);
  await runningConfiguration(vendorId, userId, serviceDate, 5);
  const cleanupReady = deferred<number>();
  const releaseCleanup = deferred();
  const writerPid = deferred<number>();
  let cleanupTransaction: Promise<unknown> | undefined;
  let writerTransaction: Promise<void> | undefined;
  try {
    cleanupTransaction = transactions.run(vendorId, async (transaction) => {
      await boundDatabaseWait(transaction);
      const result = await store.claimNext(transaction, {
        vendorId, leaseToken: randomUUID(), now: new Date('2030-01-01T00:02:00Z'),
      });
      cleanupReady.resolve(await backendPid(transaction));
      await releaseCleanup.promise;
      return result;
    });
    const cleanupPid = await bounded(cleanupReady.promise, 'expired cleanup setup');
    writerTransaction = transactions.run(vendorId, async (transaction) => {
      await boundDatabaseWait(transaction);
      writerPid.resolve(await backendPid(transaction));
      await regeneration.write(transaction, vendorId, '2030-01-01', [serviceDate], userId);
    });
    const pid = await bounded(writerPid.promise, 'expired writer start');
    await waitForDatabaseLock(pid, cleanupPid);
    releaseCleanup.resolve();
    const [claim] = await bounded(
      Promise.all([cleanupTransaction, writerTransaction]),
      'expired cleanup interleaving',
    );
    assert.equal(claim, null);
    assert.deepEqual((await owner.query<{ status: string; count: string }>(
      `SELECT status,count(*)::text FROM schedule_generation_runs
       WHERE vendor_id=$1 AND service_date=$2 GROUP BY status ORDER BY status`,
      [vendorId, serviceDate],
    )).rows, [
      { status: 'failed', count: '1' },
      { status: 'queued', count: '1' },
    ]);
    assert.equal((await owner.query(
      `SELECT 1 FROM schedule_generation_runs WHERE vendor_id=$1 AND service_date=$2
       AND trigger='configuration_change' AND status IN ('queued','running','retry_wait')`,
      [vendorId, serviceDate],
    )).rowCount, 1);
  } finally {
    releaseCleanup.resolve();
    await bounded(
      Promise.allSettled([cleanupTransaction, writerTransaction].filter((value) => value !== undefined)),
      'expired teardown',
    );
    await cleanup(vendorId);
    await owner.query('DELETE FROM users WHERE id=$1', [userId]);
  }
});

void test('run list traverses tied millisecond rows with one opaque filtered cursor and no gaps', async () => {
  const vendorId = await fixture('filtered-cursor');
  const userId = randomUUID();
  const serviceDate = '2030-01-09';
  const tiedCreatedAt = '2030-01-01T00:00:00.123Z';
  const matchingRows = [
    { id: '00000000-0000-4000-8000-000000000009', createdAt: '2030-01-01T00:00:00.124Z' },
    { id: '30000000-0000-4000-8000-000000000003', createdAt: tiedCreatedAt },
    { id: '20000000-0000-4000-8000-000000000002', createdAt: tiedCreatedAt },
    { id: '10000000-0000-4000-8000-000000000001', createdAt: tiedCreatedAt },
  ];
  await owner.query("INSERT INTO users(id,display_name,updated_at) VALUES($1,'Cursor actor',now())", [userId]);
  try {
    for (const [id, trigger, status, date, createdAt] of [
      ...matchingRows.map(({ id, createdAt }) => [id, 'manual', 'failed', serviceDate, createdAt]),
      [randomUUID(), 'manual', 'succeeded', serviceDate, tiedCreatedAt],
      [randomUUID(), 'configuration_change', 'failed', serviceDate, tiedCreatedAt],
      [randomUUID(), 'manual', 'failed', '2030-01-10', tiedCreatedAt],
    ]) {
      await owner.query(
        `INSERT INTO schedule_generation_runs(
           id,vendor_id,trigger,trigger_local_date,service_date,status,attempt_count,
           started_at,finished_at,failure_code,failure_message,requested_by_user_id,
           created_count,existing_count,updated_count,cancelled_count,missing_price_count,
           created_at,updated_at
         ) VALUES($1,$2,$3,'2030-01-01',$4,$5,1,'2030-01-01T00:00:00Z','2030-01-01T00:00:01Z',
           CASE WHEN $5='failed' THEN 'TERMINAL' END,CASE WHEN $5='failed' THEN 'Failed safely' END,$6,
           CASE WHEN $5='succeeded' THEN 0 END,CASE WHEN $5='succeeded' THEN 0 END,
           CASE WHEN $5='succeeded' THEN 0 END,CASE WHEN $5='succeeded' THEN 0 END,
           CASE WHEN $5='succeeded' THEN 0 END,$7,$7)`,
        [id, vendorId, trigger, date, status, userId, createdAt],
      );
    }
    const traversed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await transactions.run(vendorId, (transaction) => store.list(transaction, vendorId, {
        trigger: 'manual', status: 'failed', serviceDate, limit: 1, ...(cursor ? { cursor } : {}),
      }));
      assert.equal(page.items.length, 1);
      traversed.push(page.items[0].id);
      cursor = page.nextCursor;
      if (cursor) {
        assert.equal(cursor.includes(page.items[0].createdAt.toISOString()), false);
        assert.equal(cursor.includes(page.items[0].id), false);
      }
    } while (cursor);
    assert.deepEqual(traversed, matchingRows.map(({ id }) => id));
    assert.equal(new Set(traversed).size, matchingRows.length);
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
