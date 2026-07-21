import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';

import type { INestApplication } from '@nestjs/common';
import { DateTime } from 'luxon';
import pg from 'pg';

import { TenantTransactionRunner } from '../src/common/application/transaction-context.js';
import { ScheduleGenerationRunStore } from '../src/scheduling/application/schedule-generation-run.store.js';
import { ScheduleRunProcessor } from '../src/scheduling/application/schedule-run-processor.js';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const authKey = Buffer.from(process.env.AUTH_HMAC_KEY!, 'base64');
const users: string[] = [];
const vendors: string[] = [];
let app: INestApplication;
let baseUrl = '';

const hash = (value: string) => createHmac('sha256', authKey).update(value).digest('hex');
type Fixture = Readonly<{ vendorId: string; ownerId: string; ownerToken: string; serviceDate: string }>;
type ActorFixture = Readonly<{ userId: string; token: string }>;

async function actor(
  label: string,
  input: Readonly<{
    vendorId?: string;
    vendorRole?: 'vendor_owner' | 'vendor_administrator' | 'delivery_agent' | 'customer';
    platformRole?: 'product_owner' | 'platform_administrator' | 'support_operations';
    authenticationMethod: 'phone_otp' | 'administrator_mfa';
  }>,
): Promise<ActorFixture> {
  const userId = randomUUID();
  const token = randomUUID();
  users.push(userId);
  await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [userId, `Schedule ${label}`]);
  if (input.vendorId && input.vendorRole) {
    await owner.query(
      `INSERT INTO vendor_memberships(id,vendor_id,user_id,role,status,joined_at,updated_at)
       VALUES($1,$2,$3,$4::"MembershipRole",'active',now(),now())`,
      [randomUUID(), input.vendorId, userId, input.vendorRole],
    );
  }
  if (input.platformRole) {
    await owner.query(
      `INSERT INTO platform_role_assignments(id,user_id,role,granted_by)
       VALUES($1,$2,$3::"PlatformRole",$2)`,
      [randomUUID(), userId, input.platformRole],
    );
  }
  if (input.authenticationMethod === 'administrator_mfa') {
    await owner.query(
      "INSERT INTO mfa_factors(id,user_id,type,encrypted_secret,enabled_at) VALUES($1,$2,'totp','schedule',now())",
      [randomUUID(), userId],
    );
  }
  await owner.query(
    `INSERT INTO sessions(id,user_id,access_token_hash,refresh_token_hash,authentication_method,device_id,access_expires_at,expires_at,last_seen_at)
     VALUES($1,$2,$3,$4,$5::"AuthenticationMethod",$6,now()+interval '1 hour',now()+interval '1 day',now())`,
    [randomUUID(), userId, hash(token), hash(randomUUID()), input.authenticationMethod, `schedule-${userId}`],
  );
  return { userId, token };
}

async function supportGrant(vendorId: string, userId: string, scope: readonly string[]) {
  await owner.query(
    `INSERT INTO support_access_grants(
       id,vendor_id,grantee_user_id,requested_by,approved_by,purpose,scope_json,
       access_mode,starts_at,expires_at
     ) VALUES($1,$2,$3,$3,$3,'Schedule support',$4::jsonb,'read',now()-interval '1 minute',now()+interval '1 hour')`,
    [randomUUID(), vendorId, userId, JSON.stringify(scope)],
  );
}

async function fixture(label: string): Promise<Fixture> {
  const serviceDate = DateTime.now().setZone('Asia/Kolkata').toISODate()!;
  const weekday = DateTime.fromISO(serviceDate).weekday;
  const vendorId = randomUUID();
  const ownerId = randomUUID();
  const ownerToken = randomUUID();
  const householdId = randomUUID();
  const unitId = randomUUID();
  const productId = randomUUID();
  const slotId = randomUUID();
  const subscriptionId = randomUUID();
  const revisionId = randomUUID();
  users.push(ownerId);
  vendors.push(vendorId);

  await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [ownerId, `Schedule owner ${label}`]);
  await owner.query(
    `INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
     VALUES($1,$2,$3,$3,'active','Asia/Kolkata','INR',0,1,now())`,
    [vendorId, `schedule-http-${vendorId}`, `Schedule vendor ${label}`],
  );
  await owner.query(
    `INSERT INTO vendor_memberships(id,vendor_id,user_id,role,status,joined_at,updated_at)
     VALUES($1,$2,$3,'vendor_owner','active',now(),now())`,
    [randomUUID(), vendorId, ownerId],
  );
  await owner.query("INSERT INTO mfa_factors(id,user_id,type,encrypted_secret,enabled_at) VALUES($1,$2,'totp','schedule',now())", [randomUUID(), ownerId]);
  await owner.query(
    `INSERT INTO sessions(id,user_id,access_token_hash,refresh_token_hash,authentication_method,device_id,access_expires_at,expires_at,last_seen_at)
     VALUES($1,$2,$3,$4,'administrator_mfa',$5,now()+interval '1 hour',now()+interval '1 day',now())`,
    [randomUUID(), ownerId, hash(ownerToken), hash(randomUUID()), `schedule-${ownerId}`],
  );
  await owner.query(
    `INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at)
     VALUES($1,$2,$3,$4,'1 Schedule Road','Pune','Maharashtra','411001','IN',now())`,
    [householdId, vendorId, `SCH-${label}`, `Schedule household ${label}`],
  );
  await owner.query('INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,$3,$4,2,now())', [unitId, vendorId, `LITRE_${label}`, `Litre ${label}`]);
  await owner.query('INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [productId, vendorId, `MILK_${label}`, `Milk ${label}`, unitId]);
  await owner.query("INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,$3,$4,'06:00','09:00',now())", [slotId, vendorId, `MORNING_${label}`, `Morning ${label}`]);

  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [subscriptionId, vendorId, householdId]);
    await client.query(
      `INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,effective_to,created_by,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,1.25,'active',$7,$8,$9,now())`,
      [revisionId, vendorId, subscriptionId, productId, unitId, slotId, serviceDate, DateTime.fromISO(serviceDate).plus({ days: 1 }).toISODate(), ownerId],
    );
    await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,$3)', [vendorId, revisionId, weekday]);
    await client.query('COMMIT');
  } catch (cause) {
    await client.query('ROLLBACK');
    throw cause;
  } finally {
    client.release();
  }
  return { vendorId, ownerId, ownerToken, serviceDate };
}

function api(path: string, token: string, options: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function json<T>(response: Response, status: number): Promise<T> {
  if (response.status !== status) assert.fail(`expected ${status}, received ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function forbidden(response: Response) {
  const body = await json<{ code: string; message: string }>(response, 403);
  assert.deepEqual({ code: body.code, message: body.message }, {
    code: 'FORBIDDEN', message: 'You are not allowed to perform this action',
  });
}

async function waitForRun(vendorId: string, excludedRunId?: string): Promise<string> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const row = await owner.query<{ id: string }>(
      `SELECT id FROM schedule_generation_runs
       WHERE vendor_id=$1 AND trigger='manual' AND status='running'
         AND ($2::uuid IS NULL OR id<>$2::uuid)`,
      [vendorId, excludedRunId ?? null],
    );
    if (row.rows[0]) return row.rows[0].id;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('manual run did not enter running state');
}

async function rejectAuditAction(action: string) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `reject_schedule_audit_fn_${suffix}`;
  const triggerName = `reject_schedule_audit_${suffix}`;
  await owner.query(
    `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN IF NEW.action='${action}' THEN RAISE EXCEPTION 'forced schedule audit failure'; END IF; RETURN NEW; END $$`,
  );
  await owner.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  return async () => {
    await owner.query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_events`);
    await owner.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
  };
}

before(async () => {
  const { createApp } = await import('../src/bootstrap/create-app.js');
  app = await createApp({ logger: false });
  await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as Server).address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app?.close();
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query('DELETE FROM audit_events WHERE vendor_id=ANY($1::uuid[]) OR actor_user_id=ANY($2::uuid[])', [vendors, users]);
    for (const table of [
      'support_access_grants', 'schedule_generation_runs', 'scheduled_deliveries',
      'subscription_revision_weekdays', 'subscription_revisions', 'subscriptions',
      'delivery_slots', 'products', 'units', 'households', 'vendor_memberships',
    ]) await client.query(`DELETE FROM ${table} WHERE vendor_id=ANY($1::uuid[])`, [vendors]);
    await client.query('DELETE FROM platform_role_assignments WHERE user_id=ANY($1::uuid[])', [users]);
    await client.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [users]);
    await client.query('DELETE FROM mfa_factors WHERE user_id=ANY($1::uuid[])', [users]);
    await client.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    await client.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendors]);
    await client.query('COMMIT');
  } catch (cause) {
    await client.query('ROLLBACK');
    throw cause;
  } finally {
    client.release();
    await owner.end();
  }
});

void test('manual HTTP generation commits schedule, run success, and completion audit together', async () => {
  const current = await fixture('SUCCESS');
  const path = `/v1/vendors/${current.vendorId}/schedule-generation-runs`;
  const run = await json<Record<string, unknown>>(await api(`${path}/manual`, current.ownerToken, {
    method: 'POST', body: { serviceDate: current.serviceDate },
  }), 200);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.serviceDate, current.serviceDate);
  assert.deepEqual(run.counts, { created: 1, existing: 0, updated: 0, cancelled: 0, missingPrice: 1 });
  assert.equal('vendorId' in run, false);
  assert.equal('leaseToken' in run, false);

  const persisted = await owner.query<{ status: string; created_count: number }>(
    'SELECT status,created_count FROM schedule_generation_runs WHERE id=$1', [run.id],
  );
  assert.deepEqual(persisted.rows, [{ status: 'succeeded', created_count: 1 }]);
  assert.equal((await owner.query('SELECT 1 FROM scheduled_deliveries WHERE vendor_id=$1 AND service_date=$2', [current.vendorId, current.serviceDate])).rowCount, 1);
  const audits = await owner.query<{ action: string; new_value: Record<string, unknown> }>(
    `SELECT action,new_value FROM audit_events WHERE vendor_id=$1
     AND action LIKE 'schedule_generation.manual_%' ORDER BY created_at,id`,
    [current.vendorId],
  );
  assert.deepEqual(audits.rows.map(({ action }) => action), [
    'schedule_generation.manual_requested',
    'schedule_generation.manual_completed',
  ]);
  assert.deepEqual(audits.rows[1]?.new_value, {
    serviceDate: current.serviceDate,
    attempt: 1,
    counts: { created: 1, existing: 0, updated: 0, cancelled: 0, missingPrice: 1 },
  });
});

void test('manual requested audit failure rolls back the directly claimed run', async () => {
  const current = await fixture('REQUEST_ROLLBACK');
  const release = await rejectAuditAction('schedule_generation.manual_requested');
  try {
    const response = await api(`/v1/vendors/${current.vendorId}/schedule-generation-runs/manual`, current.ownerToken, {
      method: 'POST', body: { serviceDate: current.serviceDate },
    });
    const body = await json<{ code: string; message: string }>(response, 500);
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(body.message, 'An unexpected error occurred');
  } finally {
    await release();
  }
  assert.equal((await owner.query('SELECT 1 FROM schedule_generation_runs WHERE vendor_id=$1', [current.vendorId])).rowCount, 0);
  assert.equal((await owner.query('SELECT 1 FROM audit_events WHERE vendor_id=$1', [current.vendorId])).rowCount, 0);
  assert.equal((await owner.query('SELECT 1 FROM scheduled_deliveries WHERE vendor_id=$1', [current.vendorId])).rowCount, 0);
});

void test('manual completion rollback returns a safe 503 and leaves a visible retry run', async () => {
  const current = await fixture('COMPLETION_ROLLBACK');
  const path = `/v1/vendors/${current.vendorId}/schedule-generation-runs`;
  const release = await rejectAuditAction('schedule_generation.manual_completed');
  let failure: { code: string; message: string; retryable: boolean; runId: string; correlationId: string };
  try {
    failure = await json(await api(`${path}/manual`, current.ownerToken, {
      method: 'POST', body: { serviceDate: current.serviceDate },
    }), 503);
  } finally {
    await release();
  }
  assert.equal(failure.code, 'SCHEDULE_GENERATION_FAILED');
  assert.equal(failure.message, 'Schedule generation could not be completed');
  assert.equal(failure.retryable, true);
  assert.match(failure.runId, /^[0-9a-f-]{36}$/u);
  assert.doesNotMatch(JSON.stringify(failure), /forced|audit failure/iu);

  assert.equal((await owner.query('SELECT 1 FROM scheduled_deliveries WHERE vendor_id=$1', [current.vendorId])).rowCount, 0);
  const persisted = await owner.query<{ status: string; failure_code: string; failure_message: string }>(
    'SELECT status,failure_code,failure_message FROM schedule_generation_runs WHERE id=$1', [failure.runId],
  );
  assert.deepEqual(persisted.rows, [{
    status: 'retry_wait',
    failure_code: 'SCHEDULE_GENERATION_FAILED',
    failure_message: 'Schedule generation failed',
  }]);
  const list = await json<{ items: Array<Record<string, unknown>> }>(await api(
    `${path}?trigger=manual&status=retry_wait&serviceDate=${current.serviceDate}`,
    current.ownerToken,
  ), 200);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0]?.id, failure.runId);
  assert.equal(list.items[0]?.failureMessage, 'Schedule generation failed');
  assert.doesNotMatch(JSON.stringify(list), /forced|audit failure/iu);
  assert.deepEqual((await owner.query<{ action: string }>(
    `SELECT action FROM audit_events WHERE vendor_id=$1 AND action LIKE 'schedule_generation.manual_%'`,
    [current.vendorId],
  )).rows, [{ action: 'schedule_generation.manual_requested' }]);
});

void test('schedule run HTTP authorization permits only vendor managers and exact scoped support reads', async () => {
  const current = await fixture('AUTHORIZATION');
  const path = `/v1/vendors/${current.vendorId}/schedule-generation-runs`;
  const administrator = await actor('administrator', {
    vendorId: current.vendorId, vendorRole: 'vendor_administrator', authenticationMethod: 'administrator_mfa',
  });
  const exactSupport = await actor('exact support', {
    platformRole: 'support_operations', authenticationMethod: 'administrator_mfa',
  });
  await supportGrant(current.vendorId, exactSupport.userId, ['schedule:read']);
  const denied = await Promise.all([
    actor('customer', { vendorId: current.vendorId, vendorRole: 'customer', authenticationMethod: 'phone_otp' }),
    actor('agent', { vendorId: current.vendorId, vendorRole: 'delivery_agent', authenticationMethod: 'phone_otp' }),
    actor('product owner', { platformRole: 'product_owner', authenticationMethod: 'administrator_mfa' }),
    actor('platform administrator', { platformRole: 'platform_administrator', authenticationMethod: 'administrator_mfa' }),
    actor('broad support', { platformRole: 'support_operations', authenticationMethod: 'administrator_mfa' }),
    actor('wildcard support', { platformRole: 'support_operations', authenticationMethod: 'administrator_mfa' }),
  ]);
  await supportGrant(current.vendorId, denied[4].userId, ['audit:read']);
  await supportGrant(current.vendorId, denied[5].userId, ['*']);

  for (const token of [current.ownerToken, administrator.token]) {
    assert.equal((await api(path, token)).status, 200);
    assert.equal((await api(`${path}/manual`, token, {
      method: 'POST', body: { serviceDate: current.serviceDate },
    })).status, 200);
  }
  assert.equal((await api(path, exactSupport.token)).status, 200);
  await forbidden(await api(`${path}/manual`, exactSupport.token, {
    method: 'POST', body: { serviceDate: current.serviceDate },
  }));
  for (const { token } of denied) {
    await forbidden(await api(path, token));
    await forbidden(await api(`${path}/manual`, token, {
      method: 'POST', body: { serviceDate: current.serviceDate },
    }));
  }
});

void test('repeat and concurrent manual requests create distinct runs but one schedule', async () => {
  const current = await fixture('CONCURRENT');
  const path = `/v1/vendors/${current.vendorId}/schedule-generation-runs/manual`;
  const request = () => api(path, current.ownerToken, {
    method: 'POST', body: { serviceDate: current.serviceDate },
  });
  const concurrent = await Promise.all([request(), request()]);
  const runs = await Promise.all(concurrent.map((response) => json<{ id: string; status: string }>(response, 200)));
  const repeated = await json<{ id: string; status: string }>(await request(), 200);
  assert.equal(new Set([...runs.map(({ id }) => id), repeated.id]).size, 3);
  assert.ok([...runs, repeated].every(({ status }) => status === 'succeeded'));
  assert.equal((await owner.query(
    "SELECT 1 FROM schedule_generation_runs WHERE vendor_id=$1 AND trigger='manual' AND status='succeeded'",
    [current.vendorId],
  )).rowCount, 3);
  assert.equal((await owner.query(
    'SELECT 1 FROM scheduled_deliveries WHERE vendor_id=$1 AND service_date=$2',
    [current.vendorId, current.serviceDate],
  )).rowCount, 1);
});

void test('automatic and manual generation serialize to one business-key delivery', { timeout: 10_000 }, async () => {
  const current = await fixture('AUTO_MANUAL_CONCURRENT');
  const transactions = app.get(TenantTransactionRunner);
  const runs = app.get(ScheduleGenerationRunStore);
  const processor = app.get(ScheduleRunProcessor);
  const lock = await owner.connect();
  let released = false;
  let automaticProcessing: ReturnType<ScheduleRunProcessor['process']> | undefined;
  let manualResponse: Promise<Response> | undefined;

  try {
    assert.equal(await transactions.run(current.vendorId, (transaction) => runs.seedAutomatic(
      transaction,
      {
        vendorId: current.vendorId,
        triggerLocalDate: current.serviceDate,
        serviceDates: [current.serviceDate],
        now: new Date(),
      },
    )), 1);
    const automaticClaim = await transactions.run(
      current.vendorId,
      (transaction) => runs.claimNext(transaction, {
        vendorId: current.vendorId,
        leaseToken: randomUUID(),
        now: new Date(),
      }),
    );
    assert.ok(automaticClaim);
    assert.equal(automaticClaim.trigger, 'automatic');
    assert.equal(automaticClaim.serviceDate, current.serviceDate);

    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `scheduling-vendor-date:${current.vendorId}:${current.serviceDate}`,
    ]);

    automaticProcessing = processor.process(automaticClaim, randomUUID());
    manualResponse = api(
      `/v1/vendors/${current.vendorId}/schedule-generation-runs/manual`,
      current.ownerToken,
      { method: 'POST', body: { serviceDate: current.serviceDate } },
    );
    const manualRunId = await waitForRun(current.vendorId, automaticClaim.id);
    assert.notEqual(manualRunId, automaticClaim.id);

    await lock.query('COMMIT');
    released = true;
    const [automaticResult, response] = await Promise.all([automaticProcessing, manualResponse]);
    const manualResult = await json<{
      id: string;
      trigger: string;
      status: string;
      counts: { created: number; existing: number };
    }>(response, 200);

    assert.equal(automaticResult.id, automaticClaim.id);
    assert.equal(automaticResult.trigger, 'automatic');
    assert.equal(automaticResult.status, 'succeeded');
    assert.equal(manualResult.id, manualRunId);
    assert.equal(manualResult.trigger, 'manual');
    assert.equal(manualResult.status, 'succeeded');
    assert.notEqual(automaticResult.id, manualResult.id);
    assert.ok(automaticResult.counts);
    assert.deepEqual(
      [automaticResult.counts, manualResult.counts]
        .map(({ created, existing }) => [created, existing])
        .sort(([left], [right]) => left - right),
      [[0, 1], [1, 0]],
    );

    const persisted = await owner.query<{
      id: string;
      trigger: string;
      status: string;
      lease_token: string | null;
      claimed_at: Date | null;
      lease_expires_at: Date | null;
    }>(
      `SELECT id,trigger,status,lease_token,claimed_at,lease_expires_at
       FROM schedule_generation_runs WHERE id=ANY($1::uuid[]) ORDER BY trigger`,
      [[automaticResult.id, manualResult.id]],
    );
    assert.deepEqual(persisted.rows.map(({ id, trigger, status }) => ({ id, trigger, status })), [
      { id: automaticResult.id, trigger: 'automatic', status: 'succeeded' },
      { id: manualResult.id, trigger: 'manual', status: 'succeeded' },
    ]);
    assert.ok(persisted.rows.every(({ lease_token, claimed_at, lease_expires_at }) =>
      lease_token === null && claimed_at === null && lease_expires_at === null));

    const deliveries = await owner.query<{ delivery_count: number }>(
      `SELECT count(*)::int AS delivery_count FROM (
         SELECT vendor_id,subscription_id,service_date,delivery_slot_id
         FROM scheduled_deliveries WHERE vendor_id=$1 AND service_date=$2
         GROUP BY vendor_id,subscription_id,service_date,delivery_slot_id
       ) business_keys`,
      [current.vendorId, current.serviceDate],
    );
    assert.deepEqual(deliveries.rows, [{ delivery_count: 1 }]);
  } finally {
    if (!released) await lock.query('ROLLBACK').catch(() => undefined);
    lock.release();
    await Promise.allSettled([
      automaticProcessing ?? Promise.resolve(),
      manualResponse ?? Promise.resolve(),
    ]);
  }
});

void test('a live directly-running manual lease cannot be stolen', { timeout: 10_000 }, async () => {
  const current = await fixture('LIVE_LEASE');
  const lock = await owner.connect();
  let released = false;
  let response: Promise<Response> | undefined;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `scheduling-vendor-date:${current.vendorId}:${current.serviceDate}`,
    ]);
    response = api(`/v1/vendors/${current.vendorId}/schedule-generation-runs/manual`, current.ownerToken, {
      method: 'POST', body: { serviceDate: current.serviceDate },
    });
    const runId = await waitForRun(current.vendorId);
    const transactions = app.get(TenantTransactionRunner);
    const runs = app.get(ScheduleGenerationRunStore);
    const stolen = await transactions.run(current.vendorId, (transaction) => runs.claimNext(transaction, {
      vendorId: current.vendorId, leaseToken: randomUUID(), now: new Date(),
    }));
    assert.equal(stolen, null);
    assert.equal((await owner.query<{ status: string }>(
      'SELECT status FROM schedule_generation_runs WHERE id=$1', [runId],
    )).rows[0]?.status, 'running');
    await lock.query('COMMIT');
    released = true;
    assert.equal((await response).status, 200);
  } finally {
    if (!released) await lock.query('ROLLBACK');
    lock.release();
    if (response !== undefined) await response.catch(() => undefined);
  }
});

void test('an expired manual lease is reclaimed and processed with a fresh fence', async () => {
  const current = await fixture('RECLAIM');
  const runId = randomUUID();
  await owner.query(
    `INSERT INTO schedule_generation_runs(
       id,vendor_id,trigger,trigger_local_date,service_date,status,attempt_count,
       available_at,lease_token,claimed_at,lease_expires_at,started_at,requested_by_user_id,updated_at
     ) VALUES($1,$2,'manual',$3,$3,'running',1,now()-interval '2 minutes',$4,
       now()-interval '2 minutes',now()-interval '1 minute',now()-interval '2 minutes',$5,now())`,
    [runId, current.vendorId, current.serviceDate, randomUUID(), current.ownerId],
  );
  const transactions = app.get(TenantTransactionRunner);
  const runs = app.get(ScheduleGenerationRunStore);
  const claim = await transactions.run(current.vendorId, (transaction) => runs.claimNext(transaction, {
    vendorId: current.vendorId, leaseToken: randomUUID(), now: new Date(),
  }));
  assert.equal(claim?.id, runId);
  assert.equal(claim?.attempt, 2);
  const completed = await app.get(ScheduleRunProcessor).process(claim, randomUUID());
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.attempt, 2);
  assert.equal((await owner.query(
    'SELECT 1 FROM scheduled_deliveries WHERE vendor_id=$1 AND service_date=$2',
    [current.vendorId, current.serviceDate],
  )).rowCount, 1);
});
