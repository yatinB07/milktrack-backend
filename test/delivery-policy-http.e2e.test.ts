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

async function fixture(role: 'vendor_owner' | 'vendor_administrator' | 'delivery_agent' | 'customer') {
  const userId = randomUUID(), vendorId = randomUUID(), token = randomUUID(); users.push(userId); vendors.push(vendorId);
  await owner.query('INSERT INTO users (id,display_name,updated_at) VALUES ($1,$2,now())', [userId, `Policy ${role}`]);
  await owner.query(`INSERT INTO vendors (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
    VALUES ($1,$2,'Policy Vendor','Policy Vendor','active','Asia/Kolkata','INR',60,1,now())`, [vendorId, `policy-${vendorId}`]);
  await owner.query(`INSERT INTO vendor_memberships (id,vendor_id,user_id,role,status,joined_at,updated_at)
    VALUES ($1,$2,$3,$4,'active',now(),now())`, [randomUUID(), vendorId, userId, role]);
  const authenticationMethod = role === 'vendor_owner' || role === 'vendor_administrator' ? 'administrator_mfa' : 'phone_otp';
  if (authenticationMethod === 'administrator_mfa') await owner.query("INSERT INTO mfa_factors (id,user_id,type,encrypted_secret,enabled_at) VALUES ($1,$2,'totp','policy',now())", [randomUUID(), userId]);
  await owner.query(`INSERT INTO sessions (id,user_id,access_token_hash,refresh_token_hash,authentication_method,device_id,access_expires_at,expires_at,last_seen_at)
    VALUES ($1,$2,$3,$4,$5,'policy',now()+interval '1 hour',now()+interval '1 day',now())`, [randomUUID(), userId, hash(token), hash(randomUUID()), authenticationMethod]);
  return { vendorId, token };
}
function api(path: string, token: string, options: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }; if (options.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, { method: options.method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}
async function error(response: Response, status: number, code?: string) { assert.equal(response.status, status); if (code) assert.equal((await response.json() as { code: string }).code, code); }

before(async () => { const { createApp } = await import('../src/bootstrap/create-app.js'); app = await createApp({ logger: false }); await app.listen(0, '127.0.0.1'); const address = (app.getHttpServer() as Server).address(); assert.ok(address && typeof address !== 'string'); baseUrl = `http://127.0.0.1:${address.port}`; });
after(async () => { await app?.close(); await owner.query('DELETE FROM audit_events WHERE vendor_id=ANY($1::uuid[])', [vendors]); await owner.query('DELETE FROM vendor_memberships WHERE vendor_id=ANY($1::uuid[])', [vendors]); await owner.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [users]); await owner.query('DELETE FROM mfa_factors WHERE user_id=ANY($1::uuid[])', [users]); await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]); await owner.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendors]); await owner.end(); });

void test('delivery policy HTTP contract validates, authorizes, versions, and audits safe policy values', async () => {
  const current = await fixture('vendor_owner'), admin = await fixture('vendor_administrator'), agent = await fixture('delivery_agent'), customer = await fixture('customer'); const path = `/v1/vendors/${current.vendorId}/delivery-policy`;
  const get = await api(path, current.token); assert.equal(get.status, 200); assert.deepEqual(Object.keys(await get.json() as object).sort(), ['captureAgentLocationEvidence', 'lateLeavePolicy', 'skipCutoffMinutes', 'vendorId', 'version']);
  for (const body of [
    { skipCutoffMinutes: 60, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, expectedVersion: 1, reason: 'Valid reason', unknown: true },
    { skipCutoffMinutes: 10081, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, expectedVersion: 1, reason: 'Valid reason' },
    { skipCutoffMinutes: 60, lateLeavePolicy: 'invalid', captureAgentLocationEvidence: false, expectedVersion: 1, reason: 'Valid reason' },
    { skipCutoffMinutes: 60, lateLeavePolicy: 'approval', captureAgentLocationEvidence: 'false', expectedVersion: 1, reason: 'Valid reason' },
    { skipCutoffMinutes: 60, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, expectedVersion: 1, reason: 'no' },
  ]) await error(await api(path, current.token, { method: 'PATCH', body }), 400, 'INVALID_REQUEST');
  const first = await api(path, current.token, { method: 'PATCH', body: { skipCutoffMinutes: 0, lateLeavePolicy: 'reject', captureAgentLocationEvidence: true, expectedVersion: 1, reason: 'Align cutoff with dispatch' } }); assert.equal(first.status, 200); assert.deepEqual(await first.json(), { vendorId: current.vendorId, skipCutoffMinutes: 0, lateLeavePolicy: 'reject', captureAgentLocationEvidence: true, version: 2 });
  await error(await api(path, current.token, { method: 'PATCH', body: { skipCutoffMinutes: 10080, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, expectedVersion: 1, reason: 'Stale policy version' } }), 409, 'DELIVERY_POLICY_STATE_CONFLICT');
  await error(await api(`/v1/vendors/${admin.vendorId}/delivery-policy`, current.token), 403, 'FORBIDDEN');
  await error(await api(`/v1/vendors/${agent.vendorId}/delivery-policy`, agent.token), 403, 'FORBIDDEN'); await error(await api(`/v1/vendors/${customer.vendorId}/delivery-policy`, customer.token), 403, 'FORBIDDEN');
  assert.equal((await api(`/v1/vendors/${admin.vendorId}/delivery-policy`, admin.token, { method: 'PATCH', body: { skipCutoffMinutes: 10080, lateLeavePolicy: 'approval', captureAgentLocationEvidence: false, expectedVersion: 1, reason: 'Maximum supported cutoff' } })).status, 200);
  const audit = (await owner.query<{ old_value: object; new_value: object; action: string }>("SELECT action,old_value,new_value FROM audit_events WHERE vendor_id=$1 AND action='vendor.delivery_policy.updated'", [current.vendorId])).rows[0]; assert.deepEqual(audit, { action: 'vendor.delivery_policy.updated', old_value: { version: 1, lateLeavePolicy: 'approval', skipCutoffMinutes: 60, captureAgentLocationEvidence: false }, new_value: { version: 2, lateLeavePolicy: 'reject', skipCutoffMinutes: 0, captureAgentLocationEvidence: true } });
});
