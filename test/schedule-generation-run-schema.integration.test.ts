import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const runtime = new pg.Pool({ connectionString: process.env.DATABASE_URL });
test.after(() => Promise.all([owner.end(), runtime.end()]));

async function fixture(label: string) {
  const value = { vendorId: randomUUID(), userId: randomUUID() };
  await owner.query("INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())", [value.userId, `Run ${label}`]);
  await owner.query("INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,$3,$3,'active','Asia/Kolkata','INR',0,1,now())", [value.vendorId, `run-${value.vendorId}`, `Run ${label}`]);
  return value;
}

async function cleanup(values: Array<Awaited<ReturnType<typeof fixture>>>) {
  await owner.query('DELETE FROM schedule_generation_runs WHERE vendor_id=ANY($1::uuid[])', [values.map(({ vendorId }) => vendorId)]);
  await owner.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [values.map(({ vendorId }) => vendorId)]);
  await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [values.map(({ userId }) => userId)]);
}

const insert = (
  vendorId: string,
  values: Partial<{
    id: string; trigger: string; status: string; requester: string | null; triggerDate: string;
    serviceDate: string; attempt: number; maxAttempts: number; leaseToken: string | null;
    claimedAt: string | null; leaseExpiresAt: string | null; startedAt: string | null;
    finishedAt: string | null; failureCode: string | null; failureMessage: string | null;
    createdCount: number | null; existingCount: number | null; updatedCount: number | null;
    cancelledCount: number | null; missingPriceCount: number | null;
  }> = {},
) => owner.query(`INSERT INTO schedule_generation_runs(
    id,vendor_id,trigger,trigger_local_date,service_date,status,attempt_count,max_attempts,
    available_at,lease_token,claimed_at,lease_expires_at,started_at,finished_at,
    failure_code,failure_message,requested_by_user_id,created_count,existing_count,
    updated_count,cancelled_count,missing_price_count,updated_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,now())`, [
    values.id ?? randomUUID(), vendorId, values.trigger ?? 'automatic', values.triggerDate ?? '2030-01-01',
    values.serviceDate ?? '2030-01-02', values.status ?? 'queued', values.attempt ?? 0,
    values.maxAttempts ?? 5, values.leaseToken ?? null, values.claimedAt ?? null,
    values.leaseExpiresAt ?? null, values.startedAt ?? null, values.finishedAt ?? null,
    values.failureCode ?? null, values.failureMessage ?? null, values.requester ?? null,
    values.createdCount ?? null, values.existingCount ?? null, values.updatedCount ?? null,
    values.cancelledCount ?? null, values.missingPriceCount ?? null,
  ]);

void test('run ledger enforces trigger uniqueness and state consistency', async () => {
  const value = await fixture('state');
  try {
    await insert(value.vendorId);
    await assert.rejects(insert(value.vendorId), /schedule_generation_runs_automatic_key/);
    const claimedAt = new Date();
    const leaseExpiresAt = new Date(claimedAt.getTime() + 60_000);
    const manual = { trigger: 'manual', requester: value.userId, status: 'running', attempt: 1,
      leaseToken: randomUUID(), claimedAt: claimedAt.toISOString(),
      leaseExpiresAt: leaseExpiresAt.toISOString(), startedAt: claimedAt.toISOString() };
    await insert(value.vendorId, manual);
    await insert(value.vendorId, { ...manual, leaseToken: randomUUID() });
    await insert(value.vendorId, { trigger: 'configuration_change', requester: value.userId, serviceDate: '2030-01-03' });
    await assert.rejects(insert(value.vendorId, { trigger: 'configuration_change', requester: value.userId, serviceDate: '2030-01-03', status: 'retry_wait', attempt: 1, startedAt: new Date().toISOString(), failureCode: 'RETRYABLE', failureMessage: 'Retry safely' }), /schedule_generation_runs_open_configuration_key/);
    await insert(value.vendorId, { trigger: 'configuration_change', requester: value.userId, serviceDate: '2030-01-04', status: 'failed', attempt: 5, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), failureCode: 'EXHAUSTED', failureMessage: 'Attempts exhausted' });
    await insert(value.vendorId, { trigger: 'configuration_change', requester: value.userId, serviceDate: '2030-01-04' });
    await assert.rejects(insert(value.vendorId, { trigger: 'manual' }), /requester_consistency_check/);
    await assert.rejects(insert(value.vendorId, { requester: value.userId, serviceDate: '2030-01-05' }), /requester_consistency_check/);
    await assert.rejects(insert(value.vendorId, { serviceDate: '2030-01-06', maxAttempts: 0 }), /attempts_check/);
    await assert.rejects(insert(value.vendorId, { serviceDate: '2030-01-07', status: 'running', attempt: 1, startedAt: new Date().toISOString() }), /lease_consistency_check/);
    await assert.rejects(insert(value.vendorId, { serviceDate: '2030-01-08', status: 'failed', attempt: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), failureCode: 'X'.repeat(129), failureMessage: 'Safe' }), /result_consistency_check/);
    await assert.rejects(insert(value.vendorId, { serviceDate: '2030-01-09', status: 'succeeded', attempt: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }), /result_consistency_check/);
  } finally { await cleanup([value]); }
});

void test('runtime access is tenant-isolated with narrow grants and no delete', async () => {
  const values = [await fixture('tenant-a'), await fixture('tenant-b')];
  try {
    const ids = [randomUUID(), randomUUID()];
    await insert(values[0].vendorId, { id: ids[0] });
    await insert(values[1].vendorId, { id: ids[1] });
    for (const [index, other] of [[0, 1], [1, 0]] as const) {
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.vendor_id',$1,true)", [values[index].vendorId]);
        assert.equal((await client.query('SELECT id FROM schedule_generation_runs WHERE id=$1', [ids[index]])).rowCount, 1);
        assert.equal((await client.query('SELECT id FROM schedule_generation_runs WHERE id=$1', [ids[other]])).rowCount, 0);
        const runtimeId = randomUUID();
        assert.equal((await client.query(
          `INSERT INTO schedule_generation_runs
             (id,vendor_id,trigger,trigger_local_date,service_date,updated_at)
           VALUES ($1,$2,'automatic',$3,$4,now()) RETURNING id`,
          [runtimeId, values[index].vendorId, `2031-01-0${index + 1}`, `2031-02-0${index + 1}`],
        )).rowCount, 1);
        await client.query('SAVEPOINT denied_insert');
        await assert.rejects(client.query(
          `INSERT INTO schedule_generation_runs
             (id,vendor_id,trigger,trigger_local_date,service_date,updated_at)
           VALUES ($1,$2,'automatic',$3,$4,now())`,
          [randomUUID(), values[other].vendorId, `2031-03-0${index + 1}`, `2031-04-0${index + 1}`],
        ), /row-level security/);
        await client.query('ROLLBACK TO SAVEPOINT denied_insert');
        assert.equal((await client.query(
          `UPDATE schedule_generation_runs
           SET available_at=available_at + interval '1 second',updated_at=now()
           WHERE id=$1 RETURNING id`,
          [runtimeId],
        )).rowCount, 1);
        assert.equal((await client.query(
          `UPDATE schedule_generation_runs
           SET available_at=available_at + interval '1 second',updated_at=now()
           WHERE id=$1 RETURNING id`,
          [ids[other]],
        )).rowCount, 0);
        await client.query('SAVEPOINT denied_update');
        await assert.rejects(client.query('UPDATE schedule_generation_runs SET service_date=$2 WHERE id=$1', [ids[index], '2030-01-10']), /permission denied/);
        await client.query('ROLLBACK TO SAVEPOINT denied_update');
        await assert.rejects(client.query('DELETE FROM schedule_generation_runs WHERE id=$1', [ids[index]]), /permission denied/);
      } finally { await client.query('ROLLBACK'); client.release(); }
    }
    assert.deepEqual((await owner.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='schedule_generation_runs'")).rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
  } finally { await cleanup(values); }
});
