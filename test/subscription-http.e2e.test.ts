import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';

import type { INestApplication } from '@nestjs/common';
import pg from 'pg';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const authKey = Buffer.from(process.env.AUTH_HMAC_KEY!, 'base64');
const users: string[] = []; const vendors: string[] = [];
let app: INestApplication; let baseUrl = '';
const hash = (value: string) => createHmac('sha256', authKey).update(value).digest('hex');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function fixture(label: string) {
  const vendorId = randomUUID(); const ownerId = randomUUID(); const customerId = randomUUID();
  const ownerMembershipId = randomUUID(); const customerMembershipId = randomUUID(); const ownerToken = randomUUID(); const customerToken = randomUUID();
  const householdId = randomUUID(); const otherHouseholdId = randomUUID(); const raceHouseholdId = randomUUID(); const auditHouseholdId = randomUUID();
  const unitId = randomUUID(); const productId = randomUUID(); const slotId = randomUUID();
  users.push(ownerId, customerId); vendors.push(vendorId);
  await owner.query('INSERT INTO users (id,display_name,updated_at) VALUES ($1,$2,now()),($3,$4,now())', [ownerId, `Subscription Owner ${label}`, customerId, `Subscription Customer ${label}`]);
  await owner.query(
    `INSERT INTO vendors (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
     VALUES ($1,$2,$3,$3,'active','Asia/Kolkata','INR',0,1,now())`, [vendorId, `subscription-${vendorId}`, `Subscription ${label}`],
  );
  await owner.query(
    `INSERT INTO vendor_memberships (id,vendor_id,user_id,role,status,joined_at,updated_at)
     VALUES ($1,$2,$3,'vendor_owner','active',now(),now()),($4,$2,$5,'customer','active',now(),now())`,
    [ownerMembershipId, vendorId, ownerId, customerMembershipId, customerId],
  );
  await owner.query("INSERT INTO mfa_factors (id,user_id,type,encrypted_secret,enabled_at) VALUES ($1,$2,'totp','subscription',now())", [randomUUID(), ownerId]);
  await owner.query("INSERT INTO user_identities (id,user_id,type,normalized_value,verified_at,is_primary,updated_at) VALUES ($1,$2,'phone',$3,now(),true,now())", [randomUUID(), customerId, `+91${customerId.replaceAll('-', '').replace(/[a-f]/gu, '1').slice(0, 10)}`]);
  for (const [userId, token, method] of [[ownerId, ownerToken, 'administrator_mfa'], [customerId, customerToken, 'phone_otp']] as const)
    await owner.query(
      `INSERT INTO sessions (id,user_id,access_token_hash,refresh_token_hash,authentication_method,device_id,access_expires_at,expires_at,last_seen_at)
       VALUES ($1,$2,$3,$4,$5,'subscription',now()+interval '1 hour',now()+interval '1 day',now())`,
      [randomUUID(), userId, hash(token), hash(randomUUID()), method],
    );
  await owner.query(
    `INSERT INTO households (id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at)
     VALUES ($1,$5,$6,$7,'1 Test Road','Pune','Maharashtra','411001','IN',now()),
            ($2,$5,$8,$9,'2 Test Road','Pune','Maharashtra','411001','IN',now()),
            ($3,$5,$10,$11,'3 Test Road','Pune','Maharashtra','411001','IN',now()),
            ($4,$5,$12,$13,'4 Test Road','Pune','Maharashtra','411001','IN',now())`,
    [householdId, otherHouseholdId, raceHouseholdId, auditHouseholdId, vendorId,
      `SUB-${label}`, `Household ${label}`, `SUB-OTHER-${label}`, `Other ${label}`,
      `SUB-RACE-${label}`, `Race ${label}`, `SUB-AUDIT-${label}`, `Audit ${label}`],
  );
  await owner.query("INSERT INTO household_members (id,vendor_id,household_id,customer_membership_id,status,joined_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())", [randomUUID(), vendorId, householdId, customerMembershipId]);
  await owner.query('INSERT INTO units (id,vendor_id,code,name,decimal_scale,updated_at) VALUES ($1,$2,$3,$4,2,now())', [unitId, vendorId, `LITRE_${label}`, `Litre ${label}`]);
  await owner.query('INSERT INTO products (id,vendor_id,code,name,default_unit_id,updated_at) VALUES ($1,$2,$3,$4,$5,now())', [productId, vendorId, `MILK_${label}`, `Milk ${label}`, unitId]);
  await owner.query("INSERT INTO delivery_slots (id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES ($1,$2,$3,$4,'06:00','09:00',now())", [slotId, vendorId, `MORNING_${label}`, `Morning ${label}`]);
  return { vendorId, ownerToken, customerToken, householdId, otherHouseholdId, raceHouseholdId, auditHouseholdId, unitId, productId, slotId };
}

function api(path: string, token: string, options: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, { method: options.method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}
async function json<T>(response: Response, status: number): Promise<T> {
  if (response.status !== status) assert.fail(`expected ${status}, received ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
async function error(response: Response, status: number, code?: string) { const body = await json<{ code: string }>(response, status); if (code) assert.equal(body.code, code); }
type Revision = Readonly<{ id: string; quantity: string; status: string; startDate: string; endDate?: string; supersededAt?: string; createdBy?: string; supersessionReason?: string }>;
type Subscription = Readonly<{ id: string; version: number; status: string; supersededRevisionCount?: number; revisions: Revision[] }>;

before(async () => {
  const { createApp } = await import('../src/bootstrap/create-app.js'); app = await createApp({ logger: false }); await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as Server).address(); assert.ok(address && typeof address !== 'string'); baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await app?.close(); const client = await owner.connect();
  try {
    await client.query('BEGIN'); await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query('DELETE FROM schedule_generation_runs WHERE vendor_id=ANY($1::uuid[])', [vendors]);
    await client.query('DELETE FROM audit_events WHERE vendor_id=ANY($1::uuid[])', [vendors]);
    await client.query('DELETE FROM subscription_revision_weekdays WHERE vendor_id=ANY($1::uuid[])', [vendors]);
    await client.query('DELETE FROM subscription_revisions WHERE vendor_id=ANY($1::uuid[])', [vendors]);
    await client.query('DELETE FROM subscriptions WHERE vendor_id=ANY($1::uuid[])', [vendors]);
    await client.query('DELETE FROM household_members WHERE vendor_id=ANY($1::uuid[])', [vendors]);
    await client.query('DELETE FROM delivery_slots WHERE vendor_id=ANY($1::uuid[])', [vendors]);
    await client.query('DELETE FROM products WHERE vendor_id=ANY($1::uuid[])', [vendors]);
    await client.query('DELETE FROM units WHERE vendor_id=ANY($1::uuid[])', [vendors]);
    await client.query('DELETE FROM households WHERE vendor_id=ANY($1::uuid[])', [vendors]);
    await client.query('DELETE FROM vendor_memberships WHERE vendor_id=ANY($1::uuid[])', [vendors]);
    await client.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [users]);
    await client.query('DELETE FROM mfa_factors WHERE user_id=ANY($1::uuid[])', [users]);
    await client.query('DELETE FROM user_identities WHERE user_id=ANY($1::uuid[])', [users]);
    await client.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    await client.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendors]); await client.query('COMMIT');
  } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); await owner.end(); }
});

void test('subscription HTTP lifecycle enforces duplicate safety, dependency-specific transitions, customer privacy, and audit', async () => {
  const current = await fixture('A'); const other = await fixture('B'); const base = `/v1/vendors/${current.vendorId}/subscriptions`;
  const body = { householdId: current.householdId, productId: current.productId, unitId: current.unitId, deliverySlotId: current.slotId, quantity: '01.25', weekdays: [1, 3, 5], startDate: today };
  await error(await api(base, current.ownerToken, { method: 'POST', body: { ...body, quantity: 1.25 } }), 400);
  const active = await json<Subscription>(await api(base, current.ownerToken, { method: 'POST', body }), 201);
  assert.equal(active.version, 1); assert.equal(active.status, 'active'); assert.equal(active.revisions[0]?.quantity, '1.25');
  const raceBody = { ...body, householdId: current.raceHouseholdId };
  const competing = await Promise.all([api(base, current.ownerToken, { method: 'POST', body: raceBody }), api(base, current.ownerToken, { method: 'POST', body: raceBody })]);
  assert.deepEqual(competing.map(({ status }) => status).sort(), [201, 409]);
  const raced = await json<Subscription>(competing.find(({ status }) => status === 201)!, 201);

  const futureBody = { ...body, householdId: current.otherHouseholdId, startDate: '2999-01-01' };
  const future = await json<Subscription>(await api(base, current.ownerToken, { method: 'POST', body: futureBody }), 201);
  const modifyBody = {
    productId: current.productId, unitId: current.unitId, deliverySlotId: current.slotId, quantity: '2', weekdays: [2, 4],
    effectiveDate: '2999-01-01', endDate: '2999-07-31', expectedVersion: 1, reason: 'Correct future order',
  };
  const competingModifications = await Promise.all([
    api(`${base}/${future.id}/modify`, current.ownerToken, { method: 'POST', body: modifyBody }),
    api(`${base}/${future.id}/modify`, current.ownerToken, { method: 'POST', body: modifyBody }),
  ]);
  assert.deepEqual(competingModifications.map(({ status }) => status).sort(), [200, 409]);
  await error(competingModifications.find(({ status }) => status === 409)!, 409, 'SUBSCRIPTION_VERSION_CONFLICT');
  const modified = await json<Subscription>(competingModifications.find(({ status }) => status === 200)!, 200);
  assert.equal(modified.supersededRevisionCount, 1); assert.equal(modified.version, 2); assert.equal(modified.status, 'future');
  const currentRevision = modified.revisions.find(({ supersededAt }) => supersededAt === undefined); assert.ok(currentRevision);
  assert.equal(modified.revisions[0]?.id, currentRevision.id);
  assert.equal(currentRevision.startDate, '2999-01-01'); assert.equal(currentRevision.endDate, '2999-07-31');
  assert.equal('effectiveFrom' in currentRevision, false); assert.equal('effectiveTo' in currentRevision, false);

  const racePaused = await json<Subscription>(await api(`${base}/${raced.id}/pause`, current.ownerToken, { method: 'POST', body: {
    effectiveDate: today, expectedVersion: 1, reason: 'Race pause',
  } }), 200);
  assert.equal(racePaused.version, 2);
  const competingResumes = await Promise.all([
    api(`${base}/${raced.id}/resume`, current.ownerToken, { method: 'POST', body: { effectiveDate: today, expectedVersion: 2, reason: 'Race resume' } }),
    api(`${base}/${raced.id}/resume`, current.ownerToken, { method: 'POST', body: { effectiveDate: today, expectedVersion: 2, reason: 'Race resume' } }),
  ]);
  assert.deepEqual(competingResumes.map(({ status }) => status).sort(), [200, 409]);
  await error(competingResumes.find(({ status }) => status === 409)!, 409, 'SUBSCRIPTION_VERSION_CONFLICT');
  await owner.query("UPDATE subscriptions SET created_at='2000-01-01T00:00:00Z' WHERE id=$1", [future.id]);
  const futurePage = await json<{ items: Subscription[] }>(await api(`${base}?status=future&limit=1`, current.ownerToken), 200);
  assert.equal(futurePage.items.length, 1); assert.equal(futurePage.items[0]?.id, future.id);

  const beforeAuditFailure = Number((await owner.query<{ count: string }>('SELECT count(*) FROM subscriptions WHERE vendor_id=$1', [current.vendorId])).rows[0]?.count);
  const suffix = randomUUID().replaceAll('-', ''); const trigger = `reject_subscription_audit_${suffix}`; const fn = `reject_subscription_audit_fn_${suffix}`;
  try {
    await owner.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='subscription.created' THEN RAISE EXCEPTION 'forced subscription audit failure'; END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    assert.equal((await api(base, current.ownerToken, { method: 'POST', body: { ...body, householdId: current.auditHouseholdId } })).status, 500);
  } finally { await owner.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit_events`); await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`); }
  assert.equal(Number((await owner.query<{ count: string }>('SELECT count(*) FROM subscriptions WHERE vendor_id=$1', [current.vendorId])).rows[0]?.count), beforeAuditFailure);

  const customerBase = `/v1/customer/vendors/${current.vendorId}/households/${current.householdId}/subscriptions`;
  const customerList = await json<{ items: Subscription[] }>(await api(`${customerBase}?status=active`, current.customerToken), 200);
  assert.equal(customerList.items.length, 1); assert.equal(customerList.items[0]?.id, active.id);
  const history = await json<{ items: Revision[] }>(await api(`${customerBase}/${active.id}/revisions`, current.customerToken), 200);
  assert.equal('createdBy' in history.items[0], false); assert.equal('supersessionReason' in history.items[0], false);
  await error(await api(`/v1/customer/vendors/${current.vendorId}/households/${current.otherHouseholdId}/subscriptions/${future.id}`, current.customerToken), 403, 'FORBIDDEN');
  await error(await api(`${customerBase}/${future.id}`, current.customerToken), 404, 'SUBSCRIPTION_NOT_FOUND');
  await error(await api(base, current.customerToken), 403, 'FORBIDDEN'); await error(await api(base, other.ownerToken), 403, 'FORBIDDEN');

  await owner.query("UPDATE households SET status='inactive' WHERE id=$1", [current.householdId]);
  await owner.query("UPDATE products SET status='inactive' WHERE id=$1", [current.productId]);
  await owner.query('UPDATE delivery_slots SET active=false WHERE id=$1', [current.slotId]);
  const paused = await json<Subscription>(await api(`${base}/${active.id}/pause`, current.ownerToken, { method: 'POST', body: { effectiveDate: today, expectedVersion: 1, reason: 'Temporary stop' } }), 200);
  assert.equal(paused.status, 'paused');
  await error(await api(`${base}/${active.id}/resume`, current.ownerToken, { method: 'POST', body: { effectiveDate: today, expectedVersion: 2, reason: 'Try resume' } }), 409, 'SUBSCRIPTION_HOUSEHOLD_NOT_AVAILABLE');
  const cancelled = await json<Subscription>(await api(`${base}/${active.id}/cancel`, current.ownerToken, { method: 'POST', body: { effectiveDate: today, expectedVersion: 2, reason: 'End service' } }), 200);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.version, 3);
  assert.equal((await api(`${base}/${active.id}`, current.ownerToken, { method: 'DELETE', body: { expectedVersion: 3, reason: 'Archive terminal service' } })).status, 204);
  await error(await api(`${base}/${active.id}`, current.ownerToken), 404, 'SUBSCRIPTION_NOT_FOUND');
  const restored = await json<Subscription>(await api(`${base}/${active.id}/restore`, current.ownerToken, { method: 'POST', body: { expectedVersion: 4, reason: 'Restore terminal history' } }), 200);
  assert.equal(restored.status, 'cancelled'); assert.equal(restored.version, 5);
  const audits = await owner.query<{ action: string }>('SELECT action FROM audit_events WHERE vendor_id=$1 AND entity_type=$2', [current.vendorId, 'subscription']);
  for (const action of ['subscription.created', 'subscription.modified', 'subscription.paused', 'subscription.cancelled', 'subscription.deleted', 'subscription.restored'])
    assert.ok(audits.rows.some((row) => row.action === action), `missing ${action}`);
});
