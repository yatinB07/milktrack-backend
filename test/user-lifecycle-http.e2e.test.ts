import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { INestApplication } from '@nestjs/common';
import pg from 'pg';

const ownerPool = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const hmacKey = Buffer.from('0123456789abcdef0123456789abcdef');
const userIds: string[] = [];
const vendorIds: string[] = [];

function tokenHash(token: string): string {
  return createHmac('sha256', hmacKey).update(token).digest('hex');
}

async function user(displayName: string, input: Readonly<{
  id?: string;
  deleted?: boolean;
  createdAt?: string;
}> = {}): Promise<string> {
  const id = input.id ?? randomUUID();
  userIds.push(id);
  await ownerPool.query(
    `INSERT INTO users
       (id, display_name, deleted_at, deleted_by, deletion_reason, created_at, updated_at)
     VALUES ($1, $2, CASE WHEN $3 THEN now() ELSE NULL END,
             CASE WHEN $3 THEN $1::uuid ELSE NULL END,
             CASE WHEN $3 THEN 'Fixture deletion' ELSE NULL END,
             COALESCE($4::timestamptz, now()), now())`,
    [id, displayName, input.deleted ?? false, input.createdAt ?? null],
  );
  return id;
}

async function platformRole(userId: string, role: 'platform_administrator' | 'product_owner'): Promise<void> {
  await ownerPool.query(
    `INSERT INTO platform_role_assignments (id, user_id, role, granted_by)
     VALUES ($1, $2, $3::"PlatformRole", $2)`,
    [randomUUID(), userId, role],
  );
}

async function vendorOwner(userId: string): Promise<void> {
  const vendorId = randomUUID();
  vendorIds.push(vendorId);
  await ownerPool.query(
    `INSERT INTO vendors
       (id, code, legal_name, display_name, status, timezone, currency,
        skip_cutoff_minutes, billing_day, updated_at)
     VALUES ($1, $2, 'User discovery vendor', 'User discovery vendor', 'active',
             'Asia/Kolkata', 'INR', 0, 1, now())`,
    [vendorId, `user-discovery-${vendorId}`],
  );
  await ownerPool.query(
    `INSERT INTO vendor_memberships
       (id, vendor_id, user_id, role, status, joined_at, updated_at)
     VALUES ($1, $2, $3, 'vendor_owner', 'active', now(), now())`,
    [randomUUID(), vendorId, userId],
  );
}

async function session(userId: string, method: 'phone_otp' | 'administrator_mfa'): Promise<string> {
  const token = randomUUID();
  if (method === 'administrator_mfa') {
    await ownerPool.query(
      `INSERT INTO mfa_factors (id, user_id, type, encrypted_secret, enabled_at)
       VALUES ($1, $2, 'totp', 'user-discovery-fixture', now())`,
      [randomUUID(), userId],
    );
  }
  await ownerPool.query(
    `INSERT INTO sessions
       (id, user_id, access_token_hash, refresh_token_hash, authentication_method,
        device_id, access_expires_at, expires_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5::"AuthenticationMethod", 'user-discovery',
             now() + interval '1 hour', now() + interval '1 day', now())`,
    [randomUUID(), userId, tokenHash(token), tokenHash(randomUUID()), method],
  );
  return token;
}

function api(baseUrl: string, path: string, token?: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
}

async function cleanup(): Promise<void> {
  await ownerPool.query(
    `DELETE FROM audit_events
     WHERE actor_user_id = ANY($1::uuid[]) OR entity_id = ANY($1::uuid[])
        OR vendor_id = ANY($2::uuid[])`,
    [userIds, vendorIds],
  );
  await ownerPool.query('DELETE FROM vendor_memberships WHERE vendor_id = ANY($1::uuid[])', [vendorIds]);
  await ownerPool.query('DELETE FROM platform_role_assignments WHERE user_id = ANY($1::uuid[])', [userIds]);
  await ownerPool.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
  await ownerPool.query('DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])', [userIds]);
  await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
  await ownerPool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [vendorIds]);
}

void describe('platform user lifecycle discovery HTTP API', () => {
  let app: INestApplication;
  let baseUrl: string;
  let adminToken: string;
  let phoneOnlyAdminToken: string;
  let productOwnerToken: string;
  let vendorToken: string;
  let currentId: string;
  let deletedId: string;

  before(async () => {
    const adminId = await user('Discovery Administrator');
    const phoneOnlyAdminId = await user('Phone-only Administrator');
    const productOwnerId = await user('Discovery Product Owner');
    const vendorId = await user('Discovery Vendor Owner');
    currentId = await user('Current Discovery User');
    deletedId = await user('Deleted Discovery User', { deleted: true });
    await platformRole(adminId, 'platform_administrator');
    await platformRole(phoneOnlyAdminId, 'platform_administrator');
    await platformRole(productOwnerId, 'product_owner');
    await vendorOwner(vendorId);
    adminToken = await session(adminId, 'administrator_mfa');
    phoneOnlyAdminToken = await session(phoneOnlyAdminId, 'phone_otp');
    productOwnerToken = await session(productOwnerId, 'administrator_mfa');
    vendorToken = await session(vendorId, 'administrator_mfa');

    const { createApp } = await import('../src/bootstrap/create-app.js');
    app = await createApp({ logger: false });
    await app.listen(0, '127.0.0.1');
    const address = (app.getHttpServer() as Server).address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app?.close();
    await cleanup();
    await ownerPool.end();
  });

  void it('reaches current and deleted list/detail with validation, redaction, and authorization', async () => {
    for (const path of [
      '/v1/platform/users',
      `/v1/platform/users/${currentId}`,
      '/v1/platform/users?lifecycle=deleted',
      `/v1/platform/users/${deletedId}?lifecycle=deleted`,
    ]) {
      const response = await api(baseUrl, path, adminToken);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 200, JSON.stringify(body));
      const item = 'items' in body
        ? (body.items as Array<Record<string, unknown>>)[0]
        : body;
      assert.ok(item, JSON.stringify(body));
      assert.equal(item.lifecycle, path.includes('deleted') ? 'deleted' : 'current');
      for (const field of ['deletedAt', 'deletedBy', 'deletionReason', 'email', 'phone']) {
        assert.equal(field in item, false);
      }
    }

    assert.equal((await api(baseUrl, `/v1/platform/users/${currentId}?lifecycle=deleted`, adminToken)).status, 404);
    assert.equal((await api(baseUrl, `/v1/platform/users/${deletedId}`, adminToken)).status, 404);
    assert.equal((await api(baseUrl, '/v1/platform/users?lifecycle=archived', adminToken)).status, 400);
    assert.equal((await api(baseUrl, `/v1/platform/users/${currentId}?lifecycle=archived`, adminToken)).status, 400);
    assert.equal((await api(baseUrl, '/v1/platform/users?limit=101', adminToken)).status, 400);
    assert.equal((await api(baseUrl, '/v1/platform/users?cursor=tampered', adminToken)).status, 400);

    for (const token of [phoneOnlyAdminToken, productOwnerToken, vendorToken]) {
      assert.notEqual((await api(baseUrl, '/v1/platform/users', token)).status, 200);
      assert.notEqual((await api(baseUrl, `/v1/platform/users/${currentId}`, token)).status, 200);
    }
    assert.equal((await api(baseUrl, '/v1/platform/users')).status, 401);
  });

  void it('paginates equal-created users by descending ID without duplicates', async () => {
    const createdAt = '2099-07-18T12:00:00.000000Z';
    const smaller = await user('Equal smaller', {
      id: '10000000-0000-4000-8000-000000000010',
      createdAt,
    });
    const larger = await user('Equal larger', {
      id: '10000000-0000-4000-8000-000000000011',
      createdAt,
    });
    const first = await api(baseUrl, '/v1/platform/users?limit=1', adminToken);
    const firstBody = await first.json() as { items: Array<{ id: string }>; nextCursor?: string };
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    assert.deepEqual(firstBody.items.map(({ id }) => id), [larger]);
    assert.ok(firstBody.nextCursor);
    const second = await api(
      baseUrl,
      `/v1/platform/users?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      adminToken,
    );
    const secondBody = await second.json() as { items: Array<{ id: string }> };
    assert.equal(second.status, 200, JSON.stringify(secondBody));
    assert.deepEqual(secondBody.items.map(({ id }) => id), [smaller]);
  });

  void it('moves users through delete, deleted discovery, restore, and deactivation with current mutation projections', async () => {
    const targetId = await user('Lifecycle Mutation Target');
    const deactivatedId = await user('Deactivation Target');
    const deleted = await api(baseUrl, `/v1/platform/users/${targetId}`, adminToken, {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'Duplicate user account' }),
    });
    assert.equal(deleted.status, 204);
    assert.equal((await api(baseUrl, `/v1/platform/users/${targetId}`, adminToken)).status, 404);
    const deletedDetail = await api(baseUrl, `/v1/platform/users/${targetId}?lifecycle=deleted`, adminToken);
    assert.equal(deletedDetail.status, 200, await deletedDetail.text());

    const restored = await api(baseUrl, `/v1/platform/users/${targetId}/restore`, adminToken, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Confirmed valid account' }),
    });
    const restoredBody = await restored.json() as { lifecycle: string };
    assert.equal(restored.status, 200, JSON.stringify(restoredBody));
    assert.equal(restoredBody.lifecycle, 'current');
    assert.equal((await api(baseUrl, `/v1/platform/users/${targetId}`, adminToken)).status, 200);

    const deactivated = await api(baseUrl, `/v1/platform/users/${deactivatedId}/deactivate`, adminToken, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Account access ended' }),
    });
    const deactivatedBody = await deactivated.json() as { lifecycle: string; status: string };
    assert.equal(deactivated.status, 200, JSON.stringify(deactivatedBody));
    assert.equal(deactivatedBody.lifecycle, 'current');
    assert.equal(deactivatedBody.status, 'deactivated');
  });
});
