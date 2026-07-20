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

async function fixture() {
  const userId = randomUUID(); const vendorId = randomUUID(); const token = randomUUID();
  users.push(userId); vendors.push(vendorId);
  await owner.query('INSERT INTO users (id,display_name,updated_at) VALUES ($1,$2,now())', [userId, 'Slot Owner']);
  await owner.query(
    `INSERT INTO vendors (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
     VALUES ($1,$2,'Slot Vendor','Slot Vendor','active','Asia/Kolkata','INR',0,1,now())`,
    [vendorId, `slot-${vendorId}`],
  );
  await owner.query(
    `INSERT INTO vendor_memberships (id,vendor_id,user_id,role,status,joined_at,updated_at)
     VALUES ($1,$2,$3,'vendor_owner','active',now(),now())`, [randomUUID(), vendorId, userId],
  );
  await owner.query("INSERT INTO mfa_factors (id,user_id,type,encrypted_secret,enabled_at) VALUES ($1,$2,'totp','slots',now())", [randomUUID(), userId]);
  await owner.query(
    `INSERT INTO sessions (id,user_id,access_token_hash,refresh_token_hash,authentication_method,device_id,access_expires_at,expires_at,last_seen_at)
     VALUES ($1,$2,$3,$4,'administrator_mfa','slots',now()+interval '1 hour',now()+interval '1 day',now())`,
    [randomUUID(), userId, hash(token), hash(randomUUID())],
  );
  return { vendorId, token };
}
function api(path: string, token: string, options: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, { method: options.method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}
async function json<T>(response: Response, status: number): Promise<T> { assert.equal(response.status, status); return response.json() as Promise<T>; }
async function error(response: Response, status: number, code?: string) {
  const body = await json<{ code: string }>(response, status); if (code) assert.equal(body.code, code);
}
type Slot = Readonly<{ id: string; vendorId: string; code: string; name: string; startLocalTime: string; endLocalTime: string; status: 'active' | 'inactive' }>;

before(async () => {
  const { createApp } = await import('../src/bootstrap/create-app.js');
  app = await createApp({ logger: false }); await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as Server).address(); assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await app?.close();
  await owner.query('DELETE FROM audit_events WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await owner.query('DELETE FROM delivery_slots WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await owner.query('DELETE FROM vendor_memberships WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await owner.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [users]);
  await owner.query('DELETE FROM mfa_factors WHERE user_id=ANY($1::uuid[])', [users]);
  await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
  await owner.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendors]);
  await owner.end();
});

void test('delivery-slot HTTP contract validates local time, immutability, filtered cursors, tenant access, lifecycle concurrency, and audits', async () => {
  const current = await fixture(); const other = await fixture();
  const path = `/v1/vendors/${current.vendorId}/delivery-slots`;
  const morning = await json<Slot>(await api(path, current.token, {
    method: 'POST', body: { code: 'morning', name: ' Morning ', startLocalTime: '06:00', endLocalTime: '09:00' },
  }), 201);
  assert.deepEqual(Object.keys(morning).sort(), ['code', 'createdAt', 'endLocalTime', 'id', 'name', 'startLocalTime', 'status', 'updatedAt', 'vendorId']);
  assert.deepEqual({ code: morning.code, name: morning.name, start: morning.startLocalTime, end: morning.endLocalTime, status: morning.status },
    { code: 'MORNING', name: 'Morning', start: '06:00', end: '09:00', status: 'active' });
  await error(await api(`${path}/${randomUUID()}`, current.token), 404, 'DELIVERY_SLOT_NOT_FOUND');
  await error(await api(`${path}/${morning.id}`, other.token), 403, 'FORBIDDEN');
  await error(await api(`/v1/vendors/${other.vendorId}/delivery-slots/${morning.id}`, current.token), 403, 'FORBIDDEN');
  for (const body of [
    { code: 'BAD', name: 'Bad', startLocalTime: '06:00', endLocalTime: '09:00', unknown: true },
    { code: 'BAD', name: 'Bad', startLocalTime: '06:00:00', endLocalTime: '09:00' },
  ]) await error(await api(path, current.token, { method: 'POST', body }), 400);
  for (const [code, startLocalTime, endLocalTime] of [['BAD_EQUAL', '09:00', '09:00'], ['BAD_OVERNIGHT', '22:00', '06:00']])
    await error(await api(path, current.token, { method: 'POST', body: { code, name: 'Bad range', startLocalTime, endLocalTime } }), 400, 'INVALID_DELIVERY_SLOT_TIME_RANGE');
  await error(await api(`${path}/${morning.id}`, current.token, { method: 'PATCH', body: { name: 'Changed', code: 'NEW' } }), 400);
  await error(await api(`${path}/${morning.id}`, current.token, { method: 'PATCH', body: { name: 'Changed', startLocalTime: '07:00' } }), 400);
  const renamed = await json<Slot>(await api(`${path}/${morning.id}`, current.token, { method: 'PATCH', body: { name: ' Early Morning ' } }), 200);
  assert.equal(renamed.name, 'Early Morning'); assert.equal(renamed.startLocalTime, '06:00');

  const filtered: Slot[] = [];
  for (const [code, name] of [['AM_ONE', 'Morning filtered one'], ['AM_TWO', 'Morning filtered two']] as const)
    filtered.push(await json<Slot>(await api(path, current.token, { method: 'POST', body: { code, name, startLocalTime: '10:00', endLocalTime: '11:00' } }), 201));
  await owner.query('UPDATE delivery_slots SET created_at=$1 WHERE id=ANY($2::uuid[])', [new Date('2026-07-20T00:00:00Z'), filtered.map(({ id }) => id)]);
  const first = await json<{ items: Slot[]; nextCursor: string }>(await api(`${path}?search=filtered&limit=1`, current.token), 200);
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  const second = await json<{ items: Slot[] }>(await api(`${path}?search=filtered&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, current.token), 200);
  assert.equal(second.items.length, 1); assert.match(second.items[0].name, /filtered/);

  const concurrent = await Promise.all([
    api(`${path}/${morning.id}/deactivate`, current.token, { method: 'POST', body: { reason: 'Close first' } }),
    api(`${path}/${morning.id}/deactivate`, current.token, { method: 'POST', body: { reason: 'Close second' } }),
  ]);
  assert.deepEqual(concurrent.map(({ status }) => status).sort(), [200, 409]);
  await error(await api(`${path}/${morning.id}/deactivate`, current.token, { method: 'POST', body: { reason: 'Again' } }), 409, 'DELIVERY_SLOT_STATE_CONFLICT');
  const inactive = await json<{ items: Slot[] }>(await api(`${path}?status=inactive&search=early`, current.token), 200);
  assert.deepEqual(inactive.items.map(({ id }) => id), [morning.id]);
  assert.equal((await json<{ items: Slot[] }>(await api(`${path}?search=early`, current.token), 200)).items.length, 0);
  await error(await api(path, current.token, { method: 'POST', body: { code: 'morning', name: 'Duplicate', startLocalTime: '12:00', endLocalTime: '13:00' } }), 409, 'DELIVERY_SLOT_CODE_CONFLICT');
  assert.equal((await api(`${path}/${morning.id}/reactivate`, current.token, { method: 'POST', body: { reason: 'Open again' } })).status, 200);
  await error(await api(`${path}/${morning.id}/reactivate`, current.token, { method: 'POST', body: { reason: 'Again' } }), 409, 'DELIVERY_SLOT_STATE_CONFLICT');

  const suffix = randomUUID().replaceAll('-', ''); const trigger = `reject_slot_audit_${suffix}`; const fn = `reject_slot_audit_fn_${suffix}`;
  try {
    await owner.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='delivery_slot.renamed' THEN RAISE EXCEPTION 'forced slot audit failure'; END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    assert.equal((await api(`${path}/${morning.id}`, current.token, { method: 'PATCH', body: { name: 'Must roll back' } })).status, 500);
    assert.equal((await owner.query<{ name: string }>('SELECT name FROM delivery_slots WHERE id=$1', [morning.id])).rows[0]?.name, 'Early Morning');
  } finally {
    await owner.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit_events`); await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
  const audits = await owner.query<{ action: string; reason: string | null }>("SELECT action,reason FROM audit_events WHERE vendor_id=$1 AND entity_type='delivery_slot'", [current.vendorId]);
  for (const action of ['delivery_slot.created', 'delivery_slot.renamed', 'delivery_slot.deactivated', 'delivery_slot.reactivated']) assert.ok(audits.rows.some((row) => row.action === action));
  assert.ok(audits.rows.some((row) => row.action === 'delivery_slot.deactivated' && row.reason?.startsWith('Close')));
});
