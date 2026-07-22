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
  const vendorId = randomUUID(); const ownerId = randomUUID(); const customerId = randomUUID();
  const ownerMembershipId = randomUUID(); const customerMembershipId = randomUUID();
  const ownerToken = randomUUID(); const customerToken = randomUUID(); const householdId = randomUUID();
  const unitId = randomUUID(); const productId = randomUUID(); const otherUnitId = randomUUID(); const otherProductId = randomUUID(); const slotId = randomUUID();
  users.push(ownerId, customerId); vendors.push(vendorId);
  await owner.query("INSERT INTO users (id,display_name,updated_at) VALUES ($1,'Price Owner',now()),($2,'Price Customer',now())", [ownerId, customerId]);
  await owner.query(
    `INSERT INTO vendors (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
     VALUES ($1,$2,'Price Vendor','Price Vendor','active','Asia/Kolkata','INR',0,1,now())`, [vendorId, `price-${vendorId}`],
  );
  await owner.query(
    `INSERT INTO vendor_memberships (id,vendor_id,user_id,role,status,joined_at,updated_at)
     VALUES ($1,$2,$3,'vendor_owner','active',now(),now()),($4,$2,$5,'customer','active',now(),now())`,
    [ownerMembershipId, vendorId, ownerId, customerMembershipId, customerId],
  );
  await owner.query("INSERT INTO mfa_factors (id,user_id,type,encrypted_secret,enabled_at) VALUES ($1,$2,'totp','pricing',now())", [randomUUID(), ownerId]);
  await owner.query(
    "INSERT INTO user_identities (id,user_id,type,normalized_value,verified_at,is_primary,updated_at) VALUES ($1,$2,'phone',$3,now(),true,now())",
    [randomUUID(), customerId, `+91${customerId.replaceAll('-', '').replace(/[a-f]/g, '1').slice(0, 10)}`],
  );
  for (const [userId, token, method] of [[ownerId, ownerToken, 'administrator_mfa'], [customerId, customerToken, 'phone_otp']] as const)
    await owner.query(
      `INSERT INTO sessions (id,user_id,access_token_hash,refresh_token_hash,authentication_method,device_id,access_expires_at,expires_at,last_seen_at)
       VALUES ($1,$2,$3,$4,$5,'pricing',now()+interval '1 hour',now()+interval '1 day',now())`,
      [randomUUID(), userId, hash(token), hash(randomUUID()), method],
    );
  await owner.query(
    `INSERT INTO households (id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at)
     VALUES ($1,$2,'PRICE-HH','Price Household','1 Price Road','Pune','Maharashtra','411001','IN',now())`, [householdId, vendorId],
  );
  await owner.query(
    `INSERT INTO household_members (id,vendor_id,household_id,customer_membership_id,status,joined_at,updated_at)
     VALUES ($1,$2,$3,$4,'active',now(),now())`, [randomUUID(), vendorId, householdId, customerMembershipId],
  );
  await owner.query(
    `INSERT INTO units (id,vendor_id,code,name,decimal_scale,updated_at)
     VALUES ($1,$2,'LITRE','Litre',2,now()),($3,$2,'PACK','Pack',0,now())`, [unitId, vendorId, otherUnitId],
  );
  await owner.query(
    `INSERT INTO products (id,vendor_id,code,name,default_unit_id,updated_at)
     VALUES ($1,$2,'MILK','Milk',$3,now()),($4,$2,'CURD','Curd',$5,now())`, [productId, vendorId, unitId, otherProductId, otherUnitId],
  );
  await owner.query(
    `INSERT INTO delivery_slots (id,vendor_id,code,name,start_local_time,end_local_time,updated_at)
     VALUES ($1,$2,'MORNING','Morning','06:00','09:00',now())`, [slotId, vendorId],
  );
  return { vendorId, ownerToken, customerToken, householdId, productId, unitId, otherProductId, otherUnitId, slotId };
}

function api(path: string, token: string, options: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, { method: options.method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}
async function json<T>(response: Response, status: number): Promise<T> { assert.equal(response.status, status); return response.json() as Promise<T>; }
async function error(response: Response, status: number, code?: string) { const body = await json<{ code: string }>(response, status); if (code) assert.equal(body.code, code); }
type Price = Readonly<{ id: string; vendorId: string; productId: string; unitId: string; amountMinor: string; currency: string; effectiveFrom: string; effectiveTo: string | null; createdAt: string; updatedAt: string }>;
type Resolved = Readonly<{ status: 'resolved'; amountMinor: string; currency: string; source: 'customer_specific' | 'global'; sourcePriceId?: string; serviceDate?: string } | { status: 'missing'; serviceDate?: string }>;

before(async () => {
  const { createApp } = await import('../src/bootstrap/create-app.js'); app = await createApp({ logger: false }); await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as Server).address(); assert.ok(address && typeof address !== 'string'); baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await app?.close();
  await owner.query('DELETE FROM audit_events WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await owner.query('DELETE FROM customer_price_overrides WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await owner.query('DELETE FROM global_prices WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await owner.query('DELETE FROM household_members WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await owner.query('DELETE FROM delivery_slots WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await owner.query('DELETE FROM products WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await owner.query('DELETE FROM units WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await owner.query('DELETE FROM households WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await owner.query('DELETE FROM vendor_memberships WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await owner.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [users]);
  await owner.query('DELETE FROM mfa_factors WHERE user_id=ANY($1::uuid[])', [users]);
  await owner.query('DELETE FROM user_identities WHERE user_id=ANY($1::uuid[])', [users]);
  await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
  await owner.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendors]); await owner.end();
});

void test('effective pricing HTTP contract enforces history, precedence, privacy, concurrency, and atomic audit', async () => {
  const current = await fixture(); const other = await fixture();
  const globals = `/v1/vendors/${current.vendorId}/global-prices`;
  const create = (body: unknown) => api(globals, current.ownerToken, { method: 'POST', body });
  await error(await create({ productId: current.productId, unitId: current.unitId, amountMinor: 1000, effectiveFrom: '2026-01-01T00:00:00Z' }), 400);
  await error(await create({ productId: current.productId, unitId: current.unitId, amountMinor: '1000', currency: 'USD', effectiveFrom: '2026-01-01T00:00:00Z' }), 400);
  const historical = await json<Price>(await create({ productId: current.productId, unitId: current.unitId, amountMinor: '1000', effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-07-20T00:30:00Z' }), 201);
  const active = await json<Price>(await create({ productId: current.productId, unitId: current.unitId, amountMinor: '1200', effectiveFrom: '2026-07-20T00:30:00Z' }), 201);
  assert.deepEqual(Object.keys(active).sort(), ['amountMinor', 'createdAt', 'currency', 'effectiveFrom', 'effectiveTo', 'id', 'productId', 'unitId', 'updatedAt', 'vendorId']);
  assert.equal(active.currency, 'INR'); assert.equal(active.amountMinor, '1200'); assert.equal(active.effectiveTo, null);
  await error(await create({ productId: current.productId, unitId: current.unitId, amountMinor: '1300', effectiveFrom: '2026-08-01T00:00:00Z' }), 409, 'PRICE_PERIOD_OVERLAP');
  await owner.query('UPDATE global_prices SET created_at=$1 WHERE id=ANY($2::uuid[])', [new Date('2026-07-20T00:00:00Z'), [historical.id, active.id]]);
  const first = await json<{ items: Price[]; nextCursor: string }>(await api(`${globals}?productId=${current.productId}&unitId=${current.unitId}&limit=1`, current.ownerToken), 200);
  const second = await json<{ items: Price[] }>(await api(`${globals}?productId=${current.productId}&unitId=${current.unitId}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, current.ownerToken), 200);
  assert.equal(first.items.length, 1); assert.equal(second.items.length, 1); assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal((await json<Price>(await api(`${globals}/${active.id}`, current.ownerToken), 200)).id, active.id);
  await error(await api(`${globals}/${active.id}`, other.ownerToken), 403, 'FORBIDDEN');

  const resolveQuery = `householdId=${current.householdId}&productId=${current.productId}&unitId=${current.unitId}&deliverySlotId=${current.slotId}&serviceDate=2026-07-20`;
  const vendorResolvedPath = `/v1/vendors/${current.vendorId}/prices/resolved?${resolveQuery}`;
  assert.deepEqual(await json<Resolved>(await api(vendorResolvedPath, current.ownerToken), 200), { status: 'resolved', amountMinor: '1200', currency: 'INR', source: 'global', sourcePriceId: active.id });
  const overrides = `/v1/vendors/${current.vendorId}/households/${current.householdId}/price-overrides`;
  const override = await json<Price>(await api(overrides, current.ownerToken, { method: 'POST', body: {
    productId: current.productId, unitId: current.unitId, amountMinor: '900', effectiveFrom: '2026-07-19T00:00:00Z', reason: 'Customer agreement',
  } }), 201);
  assert.deepEqual(await json<Resolved>(await api(vendorResolvedPath, current.ownerToken), 200), { status: 'resolved', amountMinor: '900', currency: 'INR', source: 'customer_specific', sourcePriceId: override.id });
  const customerPath = `/v1/customer/vendors/${current.vendorId}/households/${current.householdId}/prices/resolved?productId=${current.productId}&unitId=${current.unitId}&deliverySlotId=${current.slotId}&serviceDate=2026-07-20`;
  const customerResolved = await json<Resolved>(await api(customerPath, current.customerToken), 200);
  assert.deepEqual(customerResolved, { serviceDate: '2026-07-20', status: 'resolved', amountMinor: '900', currency: 'INR', source: 'customer_specific' });
  assert.equal('sourcePriceId' in customerResolved, false);
  const unrelatedActive = randomUUID(); const unrelatedInactive = randomUUID(); const nonexistent = randomUUID();
  await owner.query(
    `INSERT INTO households (id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,status,updated_at)
     VALUES ($1,$3,'PRICE-OTHER-A','Other Active','2 Price Road','Pune','Maharashtra','411001','IN','active',now()),
            ($2,$3,'PRICE-OTHER-I','Other Inactive','3 Price Road','Pune','Maharashtra','411001','IN','inactive',now())`,
    [unrelatedActive, unrelatedInactive, current.vendorId],
  );
  for (const householdId of [unrelatedActive, unrelatedInactive, nonexistent]) {
    const path = `/v1/customer/vendors/${current.vendorId}/households/${householdId}/prices/resolved?productId=${current.productId}&unitId=${current.unitId}&deliverySlotId=${current.slotId}&serviceDate=2026-07-20`;
    await error(await api(path, current.customerToken), 403, 'FORBIDDEN');
  }
  await error(await api(globals, current.customerToken), 403, 'FORBIDDEN');
  const missingQuery = `householdId=${current.householdId}&productId=${current.otherProductId}&unitId=${current.otherUnitId}&deliverySlotId=${current.slotId}&serviceDate=2026-07-20`;
  assert.deepEqual(await json<Resolved>(await api(`/v1/vendors/${current.vendorId}/prices/resolved?${missingQuery}`, current.ownerToken), 200), { status: 'missing' });

  const closeOverride = `${overrides}/${override.id}/close`;
  assert.equal((await api(closeOverride, current.ownerToken, { method: 'POST', body: { effectiveTo: '2026-07-20T00:30:00Z', reason: 'Agreement ended' } })).status, 200);
  await error(await api(closeOverride, current.ownerToken, { method: 'POST', body: { effectiveTo: '2026-07-22T00:00:00Z', reason: 'Again' } }), 409, 'PRICE_ALREADY_CLOSED');
  assert.equal((await json<Resolved>(await api(vendorResolvedPath, current.ownerToken), 200) as Extract<Resolved, { status: 'resolved' }>).source, 'global');
  const closeGlobal = `${globals}/${active.id}/close`;
  const competing = await Promise.all([
    api(closeGlobal, current.ownerToken, { method: 'POST', body: { effectiveTo: '2026-07-21T00:00:00Z', reason: 'New price' } }),
    api(closeGlobal, current.ownerToken, { method: 'POST', body: { effectiveTo: '2026-07-22T00:00:00Z', reason: 'Competing close' } }),
  ]);
  assert.deepEqual(competing.map(({ status }) => status).sort(), [200, 409]);

  const beforeCount = Number((await owner.query<{ count: string }>('SELECT count(*) FROM global_prices WHERE vendor_id=$1', [current.vendorId])).rows[0].count);
  const suffix = randomUUID().replaceAll('-', ''); const trigger = `reject_price_audit_${suffix}`; const fn = `reject_price_audit_fn_${suffix}`;
  try {
    await owner.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='global_price.created' THEN RAISE EXCEPTION 'forced price audit failure'; END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    assert.equal((await create({ productId: current.otherProductId, unitId: current.otherUnitId, amountMinor: '700', effectiveFrom: '2026-01-01T00:00:00Z' })).status, 500);
  } finally { await owner.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit_events`); await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`); }
  assert.equal(Number((await owner.query<{ count: string }>('SELECT count(*) FROM global_prices WHERE vendor_id=$1', [current.vendorId])).rows[0].count), beforeCount);
  const audits = await owner.query<{ action: string; reason: string | null }>("SELECT action,reason FROM audit_events WHERE vendor_id=$1 AND entity_type IN ('global_price','customer_price_override')", [current.vendorId]);
  for (const action of ['global_price.created', 'global_price.closed', 'customer_price_override.created', 'customer_price_override.closed']) assert.ok(audits.rows.some((row) => row.action === action));
  assert.ok(audits.rows.some(({ action, reason }) => action === 'customer_price_override.created' && reason === 'Customer agreement'));
});
