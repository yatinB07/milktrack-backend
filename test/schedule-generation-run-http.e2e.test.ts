import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';

import type { INestApplication } from '@nestjs/common';
import { DateTime } from 'luxon';
import pg from 'pg';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const authKey = Buffer.from(process.env.AUTH_HMAC_KEY!, 'base64');
const users: string[] = [];
const vendors: string[] = [];
let app: INestApplication;
let baseUrl = '';

const hash = (value: string) => createHmac('sha256', authKey).update(value).digest('hex');
type Fixture = Readonly<{ vendorId: string; ownerId: string; ownerToken: string; serviceDate: string }>;

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
    for (const table of [
      'audit_events', 'schedule_generation_runs', 'scheduled_deliveries',
      'subscription_revision_weekdays', 'subscription_revisions', 'subscriptions',
      'delivery_slots', 'products', 'units', 'households', 'vendor_memberships',
    ]) await client.query(`DELETE FROM ${table} WHERE vendor_id=ANY($1::uuid[])`, [vendors]);
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
