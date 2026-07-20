import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';

const ownerPool = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const authKey = Buffer.from(process.env.AUTH_HMAC_KEY!, 'base64');
const users: string[] = [];
const vendors: string[] = [];
let app: INestApplication;
let baseUrl = '';
const hash = (token: string) => createHmac('sha256', authKey).update(token).digest('hex');

async function fixture() {
  const userId = randomUUID(); const vendorId = randomUUID(); const token = randomUUID();
  users.push(userId); vendors.push(vendorId);
  await ownerPool.query('INSERT INTO users (id,display_name,updated_at) VALUES ($1,$2,now())', [userId, 'Catalog Owner']);
  await ownerPool.query(
    `INSERT INTO vendors (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
     VALUES ($1,$2,'Catalog Vendor','Catalog Vendor','active','Asia/Kolkata','INR',0,1,now())`,
    [vendorId, `catalog-${vendorId}`],
  );
  await ownerPool.query(
    `INSERT INTO vendor_memberships (id,vendor_id,user_id,role,status,joined_at,updated_at)
     VALUES ($1,$2,$3,'vendor_owner','active',now(),now())`,
    [randomUUID(), vendorId, userId],
  );
  await ownerPool.query(
    "INSERT INTO mfa_factors (id,user_id,type,encrypted_secret,enabled_at) VALUES ($1,$2,'totp','catalog',now())",
    [randomUUID(), userId],
  );
  await ownerPool.query(
    `INSERT INTO sessions (id,user_id,access_token_hash,refresh_token_hash,authentication_method,device_id,access_expires_at,expires_at,last_seen_at)
     VALUES ($1,$2,$3,$4,'administrator_mfa','catalog',now()+interval '1 hour',now()+interval '1 day',now())`,
    [randomUUID(), userId, hash(token), hash(randomUUID())],
  );
  return { userId, vendorId, token };
}
function api(path: string, token: string, options: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, { method: options.method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}
async function json<T>(response: Response, status: number): Promise<T> {
  assert.equal(response.status, status); return response.json() as Promise<T>;
}
async function error(response: Response, status: number, code?: string) {
  const body = await json<{ code: string }>(response, status); if (code) assert.equal(body.code, code);
}

before(async () => {
  const { createApp } = await import('../src/bootstrap/create-app.js');
  app = await createApp({ logger: false }); await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as Server).address(); assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await app?.close();
  await ownerPool.query('DELETE FROM audit_events WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await ownerPool.query('DELETE FROM products WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await ownerPool.query('DELETE FROM units WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await ownerPool.query('DELETE FROM vendor_memberships WHERE vendor_id=ANY($1::uuid[])', [vendors]);
  await ownerPool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [users]);
  await ownerPool.query('DELETE FROM mfa_factors WHERE user_id=ANY($1::uuid[])', [users]);
  await ownerPool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
  await ownerPool.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendors]);
  await ownerPool.end();
});

void test('catalog HTTP lifecycle enforces validation, cursor filters, unit rules, versions, soft delete, restore, and audit', async () => {
  const { vendorId, token } = await fixture(); const other = await fixture(); const path = `/v1/vendors/${vendorId}`;
  type Unit = { id: string; code: string; name: string; status: string };
  type Product = { id: string; code: string; status: string; version: number };
  const litre = await json<Unit>(await api(`${path}/units`, token, {
    method: 'POST', body: { code: 'ltr', name: ' Litre ', decimalScale: 2 },
  }), 201);
  assert.equal(litre.code, 'LTR'); assert.equal(litre.name, 'Litre');
  await error(await api(`${path}/units/${litre.id}`, other.token), 403, 'FORBIDDEN');
  await error(await api(`/v1/vendors/${other.vendorId}/units/${litre.id}`, token), 403, 'FORBIDDEN');
  await json<Unit>(await api(`${path}/units`, token, { method: 'POST', body: { code: 'ml', name: 'Milk millilitre', decimalScale: 2 } }), 201);
  await json<Unit>(await api(`${path}/units`, token, { method: 'POST', body: { code: 'crate', name: 'Milk crate', decimalScale: 0 } }), 201);
  await error(await api(`${path}/units`, token, { method: 'POST', body: { code: 'BAD', name: 'Bad', decimalScale: 1, unknown: true } }), 400);

  const firstPage = await json<{ items: Unit[]; nextCursor: string }>(await api(`${path}/units?search=milk&limit=1`, token), 200);
  assert.equal(firstPage.items.length, 1); assert.ok(firstPage.nextCursor);
  const secondPage = await json<{ items: Unit[] }>(await api(`${path}/units?search=milk&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`, token), 200);
  assert.equal(secondPage.items.length, 1); assert.match(secondPage.items[0].name, /Milk/);

  const inactive = await json<Unit>(await api(`${path}/units/${litre.id}/deactivate`, token, { method: 'POST', body: { reason: 'Prepare validation' } }), 200);
  assert.equal(inactive.status, 'inactive');
  await error(await api(`${path}/products`, token, { method: 'POST', body: { code: 'milk', name: 'Milk', defaultUnitId: litre.id } }), 409, 'CATALOG_UNIT_NOT_AVAILABLE');
  await json<Unit>(await api(`${path}/units/${litre.id}/reactivate`, token, { method: 'POST', body: { reason: 'Sell by litre' } }), 200);
  await error(await api(`${path}/products`, token, { method: 'POST', body: { code: 'milk', name: 'Milk', defaultUnitId: litre.id, expectedVersion: 1 } }), 400);
  const product = await json<Product>(await api(`${path}/products`, token, { method: 'POST', body: { code: 'milk', name: ' Milk ', defaultUnitId: litre.id } }), 201);
  assert.equal(product.code, 'MILK'); assert.equal(product.version, 1);
  await error(await api(`${path}/units/${litre.id}/deactivate`, token, { method: 'POST', body: { reason: 'Cannot while active' } }), 409, 'CATALOG_UNIT_IN_USE');

  const inactiveProduct = await json<Product>(await api(`${path}/products/${product.id}`, token, { method: 'PATCH', body: { expectedVersion: 1, status: 'inactive' } }), 200);
  assert.equal(inactiveProduct.version, 2); assert.equal(inactiveProduct.status, 'inactive');
  await json<Unit>(await api(`${path}/units/${litre.id}/deactivate`, token, { method: 'POST', body: { reason: 'No active product remains' } }), 200);
  await error(await api(`${path}/products/${product.id}`, token, { method: 'PATCH', body: { expectedVersion: 2, status: 'active' } }), 409, 'CATALOG_UNIT_NOT_AVAILABLE');
  await error(await api(`${path}/products/${product.id}`, token, { method: 'PATCH', body: { expectedVersion: 1, name: 'Stale' } }), 409, 'CATALOG_PRODUCT_VERSION_CONFLICT');
  const deleted = await api(`${path}/products/${product.id}`, token, { method: 'DELETE', body: { expectedVersion: 2, reason: 'Replace product' } });
  assert.equal(deleted.status, 204);
  await error(await api(`${path}/products/${product.id}`, token), 404, 'CATALOG_PRODUCT_NOT_FOUND');
  await error(await api(`${path}/products/${product.id}/restore`, token, { method: 'POST', body: { expectedVersion: 3, reason: 'Unit remains inactive' } }), 409, 'CATALOG_UNIT_NOT_AVAILABLE');
  await json<Unit>(await api(`${path}/units/${litre.id}/reactivate`, token, { method: 'POST', body: { reason: 'Restore sales' } }), 200);
  const replacement = await json<Product>(await api(`${path}/products`, token, { method: 'POST', body: { code: 'milk', name: 'Replacement', defaultUnitId: litre.id } }), 201);
  await error(await api(`${path}/products/${product.id}/restore`, token, { method: 'POST', body: { expectedVersion: 3, reason: 'Restore original' } }), 409, 'CATALOG_PRODUCT_CONFLICT');
  assert.equal((await api(`${path}/products/${replacement.id}`, token, { method: 'DELETE', body: { expectedVersion: 1, reason: 'Use original' } })).status, 204);
  const restored = await json<Product>(await api(`${path}/products/${product.id}/restore`, token, { method: 'POST', body: { expectedVersion: 3 } }), 200);
  assert.equal(restored.version, 4);

  const concurrent = await Promise.all([
    api(`${path}/products/${product.id}`, token, { method: 'PATCH', body: { expectedVersion: 4, name: 'Concurrent A' } }),
    api(`${path}/products/${product.id}`, token, { method: 'PATCH', body: { expectedVersion: 4, name: 'Concurrent B' } }),
  ]);
  assert.deepEqual(concurrent.map(({ status }) => status).sort(), [200, 409]);
  const another = await json<Product>(await api(`${path}/products`, token, { method: 'POST', body: { code: 'CURD', name: 'Concurrent curd', defaultUnitId: litre.id } }), 201);
  await json<Product>(await api(`${path}/products/${another.id}`, token, { method: 'PATCH', body: { expectedVersion: 1, status: 'inactive' } }), 200);
  const productPageOne = await json<{ items: Product[]; nextCursor: string }>(await api(`${path}/products?status=inactive&search=concurrent&limit=1`, token), 200);
  assert.equal(productPageOne.items.length, 1); assert.ok(productPageOne.nextCursor);
  const productPageTwo = await json<{ items: Product[] }>(await api(`${path}/products?status=inactive&search=concurrent&limit=1&cursor=${encodeURIComponent(productPageOne.nextCursor)}`, token), 200);
  assert.equal(productPageTwo.items.length, 1);
  assert.equal((await json<{ items: Product[] }>(await api(`${path}/products?status=inactive&search=replacement`, token), 200)).items.length, 0);

  const suffix = randomUUID().replaceAll('-', ''); const trigger = `reject_catalog_audit_${suffix}`; const triggerFunction = `reject_catalog_audit_fn_${suffix}`;
  try {
    await ownerPool.query(
      `CREATE FUNCTION ${triggerFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN IF NEW.action = 'unit.renamed' THEN RAISE EXCEPTION 'forced catalog audit failure'; END IF; RETURN NEW; END $$`,
    );
    await ownerPool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}()`);
    assert.equal((await api(`${path}/units/${litre.id}`, token, { method: 'PATCH', body: { name: 'Must roll back' } })).status, 500);
    assert.equal((await ownerPool.query<{ name: string }>('SELECT name FROM units WHERE id=$1', [litre.id])).rows[0]?.name, 'Litre');
  } finally {
    await ownerPool.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit_events`);
    await ownerPool.query(`DROP FUNCTION IF EXISTS ${triggerFunction}()`);
  }
  const actions = (await ownerPool.query<{ action: string }>("SELECT action FROM audit_events WHERE vendor_id=$1 AND entity_type IN ('unit','product')", [vendorId])).rows.map(({ action }) => action);
  for (const action of ['unit.created', 'unit.deactivated', 'unit.reactivated', 'product.created', 'product.updated', 'product.deleted', 'product.restored']) assert.ok(actions.includes(action));
  assert.equal(actions.includes('product.deactivated'), false);
});
