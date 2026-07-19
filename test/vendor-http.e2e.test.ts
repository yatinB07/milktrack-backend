import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';

import type { INestApplication } from '@nestjs/common';
import pg from 'pg';

const ownerPool = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});
const authKey = Buffer.from(process.env.AUTH_HMAC_KEY!, 'base64');
const actorIds: string[] = [];
const vendorIds: string[] = [];
let app: INestApplication;
let baseUrl: string;
let administratorToken: string;
let productOwnerToken: string;

const responseKeys = [
  'allowedTransitions',
  'billingDay',
  'code',
  'createdAt',
  'currency',
  'displayName',
  'id',
  'legalName',
  'skipCutoffMinutes',
  'status',
  'timezone',
  'updatedAt',
  'version',
];

const createBody = (code: string) => ({
  code,
  legalName: 'North Star Dairy Private Limited',
  displayName: 'North Star Dairy',
  timezone: 'Asia/Kolkata',
  currency: 'INR',
  skipCutoffMinutes: 120,
  billingDay: 10,
});

async function seedPlatformActor(
  role: 'platform_administrator' | 'product_owner',
): Promise<string> {
  const userId = randomUUID();
  const token = `vendor-api-${role}-${randomUUID()}`;
  actorIds.push(userId);
  await ownerPool.query(
    `INSERT INTO users (id, display_name, updated_at)
     VALUES ($1, $2, now())`,
    [userId, role === 'platform_administrator' ? 'Administrator' : 'Product Owner'],
  );
  await ownerPool.query(
    `INSERT INTO platform_role_assignments (id, user_id, role, granted_by)
     VALUES ($1, $2, $3, $2)`,
    [randomUUID(), userId, role],
  );
  await ownerPool.query(
    `INSERT INTO mfa_factors (id, user_id, type, encrypted_secret, enabled_at)
     VALUES ($1, $2, 'totp', 'vendor-http-fixture', now())`,
    [randomUUID(), userId],
  );
  await ownerPool.query(
    `INSERT INTO sessions
       (id, user_id, access_token_hash, refresh_token_hash, authentication_method,
        device_id, access_expires_at, expires_at, last_seen_at)
     VALUES ($1, $2, $3, $4, 'administrator_mfa', 'vendor-api-test',
             now() + interval '15 minutes', now() + interval '30 days', now())`,
    [
      randomUUID(),
      userId,
      createHmac('sha256', authKey).update(token).digest('hex'),
      createHmac('sha256', authKey).update(`${token}-refresh`).digest('hex'),
    ],
  );
  return token;
}

async function seedVendorActor(input: Readonly<{
  vendorId: string;
  role: 'vendor_owner' | 'vendor_administrator' | 'delivery_agent' | 'customer';
  membershipStatus?: 'active' | 'ended';
  deleted?: boolean;
}>): Promise<string> {
  const userId = randomUUID();
  const token = `vendor-profile-${input.role}-${randomUUID()}`;
  const authenticationMethod =
    input.role === 'vendor_owner' || input.role === 'vendor_administrator'
      ? 'administrator_mfa'
      : 'phone_otp';
  actorIds.push(userId);
  await ownerPool.query(
    `INSERT INTO users (id, display_name, updated_at)
     VALUES ($1, $2, now())`,
    [userId, `Vendor ${input.role}`],
  );
  await ownerPool.query(
    `INSERT INTO vendor_memberships
       (id, vendor_id, user_id, role, status, joined_at, ended_at, deleted_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), $6, $7, now())`,
    [
      randomUUID(),
      input.vendorId,
      userId,
      input.role,
      input.membershipStatus ?? 'active',
      input.membershipStatus === 'ended' ? new Date() : null,
      input.deleted ? new Date() : null,
    ],
  );
  if (authenticationMethod === 'administrator_mfa') {
    await ownerPool.query(
      `INSERT INTO mfa_factors (id, user_id, type, encrypted_secret, enabled_at)
       VALUES ($1, $2, 'totp', 'vendor-profile-fixture', now())`,
      [randomUUID(), userId],
    );
  }
  await ownerPool.query(
    `INSERT INTO sessions
       (id, user_id, access_token_hash, refresh_token_hash, authentication_method,
        device_id, access_expires_at, expires_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, 'vendor-profile-test',
             now() + interval '15 minutes', now() + interval '30 days', now())`,
    [
      randomUUID(),
      userId,
      createHmac('sha256', authKey).update(token).digest('hex'),
      createHmac('sha256', authKey).update(`${token}-refresh`).digest('hex'),
      authenticationMethod,
    ],
  );
  return token;
}

async function insertVendorProfileFixture(
  status:
    | 'pending_approval'
    | 'onboarding'
    | 'trial'
    | 'active'
    | 'suspended'
    | 'closed' = 'active',
  deleted = false,
): Promise<string> {
  const id = randomUUID();
  vendorIds.push(id);
  await ownerPool.query(
    `INSERT INTO vendors
       (id, code, legal_name, display_name, status, timezone, currency,
        skip_cutoff_minutes, billing_day, deleted_at, updated_at)
     VALUES ($1, $2, 'Profile Legal Name', 'Profile Display Name', $3,
             'Asia/Kolkata', 'INR', 15, 10, $4, now())`,
    [id, `PROFILE_${id.replaceAll('-', '').slice(0, 20).toUpperCase()}`, status, deleted ? new Date() : null],
  );
  return id;
}

function api(
  path: string,
  token: string,
  options: Readonly<{ method?: string; body?: unknown; correlationId?: string }> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.correlationId === undefined
        ? {}
        : { 'x-correlation-id': options.correlationId }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function expectError(
  response: Response,
  status: number,
  code?: string,
): Promise<Record<string, unknown>> {
  assert.equal(response.status, status);
  const body = (await response.json()) as Record<string, unknown>;
  if (code !== undefined) assert.equal(body.code, code);
  return body;
}

async function deleteVendors(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await ownerPool.query('DELETE FROM audit_events WHERE vendor_id = ANY($1::uuid[])', [ids]);
  await ownerPool.query('DELETE FROM vendor_memberships WHERE vendor_id = ANY($1::uuid[])', [ids]);
  await ownerPool.query('DELETE FROM vendors WHERE id = ANY($1::uuid[])', [ids]);
}

before(async () => {
  const { createApp } = await import('../src/bootstrap/create-app.js');
  [administratorToken, productOwnerToken] = await Promise.all([
    seedPlatformActor('platform_administrator'),
    seedPlatformActor('product_owner'),
  ]);
  app = await createApp({ logger: false });
  await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as Server).address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app?.close();
  await deleteVendors(vendorIds);
  if (actorIds.length > 0) {
    await ownerPool.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::uuid[])', [actorIds]);
    await ownerPool.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [actorIds]);
    await ownerPool.query('DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])', [actorIds]);
    await ownerPool.query(
      'DELETE FROM platform_role_assignments WHERE user_id = ANY($1::uuid[])',
      [actorIds],
    );
    await ownerPool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [actorIds]);
  }
  await ownerPool.end();
});

void test('platform permissions, DTO mapping, creation, detail, and transitions are enforced', async () => {
  await expectError(
    await api('/v1/platform/vendors', productOwnerToken, {
      method: 'POST',
      body: createBody(`PO_${randomUUID().slice(0, 8).toUpperCase()}`),
    }),
    403,
    'FORBIDDEN',
  );

  const code = `CREATE_${randomUUID().slice(0, 8).toUpperCase()}`;
  const createdResponse = await api('/v1/platform/vendors', administratorToken, {
    method: 'POST',
    body: createBody(code),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(created).sort(), responseKeys);
  assert.equal(created.code, code);
  assert.equal(created.status, 'pending_approval');
  assert.deepEqual(created.allowedTransitions, ['onboarding']);
  assert.equal(created.version, 1);
  assert.equal(new Date(String(created.createdAt)).toISOString(), created.createdAt);
  vendorIds.push(String(created.id));

  const detailResponse = await api(
    `/v1/platform/vendors/${String(created.id)}`,
    productOwnerToken,
  );
  assert.equal(detailResponse.status, 200);
  assert.deepEqual(await detailResponse.json(), created);

  await expectError(
    await api(`/v1/platform/vendors/${String(created.id)}/transitions`, productOwnerToken, {
      method: 'POST',
      body: { to: 'onboarding', reason: 'Approved documents', expectedVersion: 1 },
    }),
    403,
    'FORBIDDEN',
  );
  await expectError(
    await api(`/v1/platform/vendors/${String(created.id)}/transitions`, administratorToken, {
      method: 'POST',
      body: { to: 'onboarding', expectedVersion: 1 },
    }),
    400,
  );
  const transitionResponse = await api(
    `/v1/platform/vendors/${String(created.id)}/transitions`,
    administratorToken,
    {
      method: 'POST',
      body: { to: 'onboarding', reason: ' Approved documents ', expectedVersion: 1 },
    },
  );
  assert.equal(transitionResponse.status, 200);
  const transitioned = (await transitionResponse.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(transitioned).sort(), responseKeys);
  assert.equal(transitioned.status, 'onboarding');
  assert.deepEqual(transitioned.allowedTransitions, ['trial', 'active']);
  assert.equal(transitioned.version, 2);
  await expectError(
    await api(`/v1/platform/vendors/${String(created.id)}/transitions`, administratorToken, {
      method: 'POST',
      body: { to: 'active', reason: 'Stale approval attempt', expectedVersion: 1 },
    }),
    409,
    'VENDOR_STATE_CONFLICT',
  );

  const audits = await ownerPool.query<{
    action: string;
    actor_user_id: string;
    new_value: unknown;
    reason: string | null;
  }>(
    `SELECT action, actor_user_id, new_value, reason
     FROM audit_events WHERE vendor_id = $1 ORDER BY created_at`,
    [created.id],
  );
  assert.deepEqual(audits.rows.map(({ action }) => action), [
    'vendor.created',
    'vendor.lifecycle_changed',
  ]);
  assert.ok(audits.rows.every(({ actor_user_id }) => actor_user_id === actorIds[0]));
  assert.deepEqual(audits.rows[0]?.new_value, { code, status: 'pending_approval' });
  assert.equal(audits.rows[0]?.reason, null);
  assert.equal(audits.rows[1]?.reason, 'Approved documents');
});

void test('vendor profiles are tenant-safe, lifecycle-gated, and expose only the vendor DTO', async () => {
  for (const status of ['onboarding', 'trial', 'active'] as const) {
    const vendorId = await insertVendorProfileFixture(status);
    for (const role of ['vendor_owner', 'vendor_administrator'] as const) {
      const token = await seedVendorActor({ vendorId, role });
      const response = await api(`/v1/vendors/${vendorId}/profile`, token);
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), responseKeys);
      assert.equal(body.id, vendorId);
      assert.equal(body.status, status);
      assert.equal(body.displayName, 'Profile Display Name');
    }
  }

  const targetVendorId = await insertVendorProfileFixture();
  const otherVendorId = await insertVendorProfileFixture();
  await seedVendorActor({ vendorId: targetVendorId, role: 'vendor_owner' });
  const otherOwner = await seedVendorActor({ vendorId: otherVendorId, role: 'vendor_owner' });
  await expectError(
    await api(`/v1/vendors/${targetVendorId}/profile`, otherOwner),
    403,
    'FORBIDDEN',
  );
  for (const role of ['delivery_agent', 'customer'] as const) {
    const token = await seedVendorActor({ vendorId: targetVendorId, role });
    await expectError(
      await api(`/v1/vendors/${targetVendorId}/profile`, token),
      403,
      'FORBIDDEN',
    );
  }
  await expectError(
    await api(`/v1/vendors/${targetVendorId}/profile`, administratorToken),
    403,
    'FORBIDDEN',
  );
  for (const input of [
    { membershipStatus: 'ended' as const },
    { deleted: true },
  ]) {
    const token = await seedVendorActor({
      vendorId: targetVendorId,
      role: 'vendor_owner',
      ...input,
    });
    await expectError(
      await api(`/v1/vendors/${targetVendorId}/profile`, token),
      401,
      'UNAUTHENTICATED',
    );
  }
  for (const [status, deleted] of [
    ['pending_approval', false],
    ['suspended', false],
    ['closed', false],
    ['active', true],
  ] as const) {
    const vendorId = await insertVendorProfileFixture(status, deleted);
    const token = await seedVendorActor({ vendorId, role: 'vendor_administrator' });
    await expectError(
      await api(`/v1/vendors/${vendorId}/profile`, token),
      401,
      'UNAUTHENTICATED',
    );
  }
});

void test('product owners search active vendors by status and page without duplicates', async () => {
  const search = `SEARCH${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  const rows = [
    { id: randomUUID(), code: `CODE_${search}`, legalName: 'Unrelated legal name', displayName: 'Unrelated display name', status: 'suspended' },
    { id: randomUUID(), code: `LEGAL_${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`, legalName: `Legal ${search}`, displayName: 'Unrelated display name', status: 'suspended' },
    { id: randomUUID(), code: `DISPLAY_${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`, legalName: 'Unrelated legal name', displayName: `Display ${search}`, status: 'suspended' },
    { id: randomUUID(), code: `PENDING_${search}`, legalName: 'Unrelated legal name', displayName: 'Unrelated display name', status: 'pending_approval' },
  ] as const;
  vendorIds.push(...rows.map(({ id }) => id));
  for (const [index, row] of rows.entries()) {
    await ownerPool.query(
      `INSERT INTO vendors
         (id, code, legal_name, display_name, status, timezone, currency,
          skip_cutoff_minutes, billing_day, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'Asia/Kolkata', 'INR', 0, 1, $6, $6)`,
      [
        row.id,
        row.code,
        row.legalName,
        row.displayName,
        row.status,
        new Date(Date.UTC(2098, 6, 18, 12, 0, index)),
      ],
    );
  }

  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const response = await api(
      `/v1/platform/vendors?status=suspended&search=${search.toLowerCase()}&limit=1${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      productOwnerToken,
    );
    assert.equal(response.status, 200);
    const page = (await response.json()) as {
      items: Array<{ id: string; allowedTransitions: string[] }>;
      nextCursor?: string;
    };
    assert.equal(page.items.length, 1);
    const [item] = page.items;
    assert.ok(item);
    assert.deepEqual(item.allowedTransitions, ['active', 'closed']);
    ids.push(item.id);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  assert.deepEqual(new Set(ids), new Set(rows.slice(0, 3).map(({ id }) => id)));
  assert.equal(ids.length, 3);
});

void test('vendor search treats PostgreSQL pattern characters literally', async () => {
  const token = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  const searches = [`PERCENT%${token}`, `UNDERSCORE_${token}`, `BACKSLASH\\${token}`];

  for (const search of searches) {
    const targetId = randomUUID();
    const unrelatedId = randomUUID();
    vendorIds.push(targetId, unrelatedId);
    await ownerPool.query(
      `INSERT INTO vendors
         (id, code, legal_name, display_name, status, timezone, currency,
          skip_cutoff_minutes, billing_day, updated_at)
       VALUES
         ($1, $2, 'Literal search target', 'Literal search target', 'suspended', 'Asia/Kolkata', 'INR', 0, 1, now()),
         ($3, $4, 'Unrelated vendor', 'Unrelated vendor', 'suspended', 'Asia/Kolkata', 'INR', 0, 1, now())`,
      [targetId, search, unrelatedId, `${search.replaceAll('%', 'X').replaceAll('_', 'X').replaceAll('\\', '')}`],
    );

    const response = await api(
      `/v1/platform/vendors?status=suspended&search=${encodeURIComponent(search)}`,
      productOwnerToken,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { items: Array<{ id: string }> };
    assert.deepEqual(body.items.map(({ id }) => id), [targetId]);
  }
});

void test('vendor search rejects blank and overlong values', async () => {
  await expectError(
    await api('/v1/platform/vendors?search=%20%20%20', productOwnerToken),
    400,
  );
  await expectError(
    await api(`/v1/platform/vendors?search=${'x'.repeat(121)}`, productOwnerToken),
    400,
  );
});

void test('create validation, active-code uniqueness, and soft-delete filtering are stable', async () => {
  const code = `UNIQUE_${randomUUID().slice(0, 8).toUpperCase()}`;
  const firstResponse = await api('/v1/platform/vendors', administratorToken, {
    method: 'POST',
    body: createBody(code),
  });
  assert.equal(firstResponse.status, 201);
  const first = (await firstResponse.json()) as Record<string, unknown>;
  vendorIds.push(String(first.id));
  await expectError(
    await api('/v1/platform/vendors', administratorToken, {
      method: 'POST',
      body: createBody(code),
    }),
    409,
    'VENDOR_CODE_CONFLICT',
  );

  const invalidRequests = [
    { ...createBody('lowercase'), code: 'lowercase' },
    { ...createBody(`BAD_${randomUUID().slice(0, 8).toUpperCase()}`), currency: 'inr' },
    { ...createBody(`BAD_${randomUUID().slice(0, 8).toUpperCase()}`), billingDay: 29 },
    { ...createBody(`BAD_${randomUUID().slice(0, 8).toUpperCase()}`), skipCutoffMinutes: -1 },
    { ...createBody(`BAD_${randomUUID().slice(0, 8).toUpperCase()}`), unknown: true },
  ];
  for (const body of invalidRequests) {
    await expectError(
      await api('/v1/platform/vendors', administratorToken, { method: 'POST', body }),
      400,
    );
  }
  await expectError(
    await api('/v1/platform/vendors', administratorToken, {
      method: 'POST',
      body: {
        ...createBody(`ZONE_${randomUUID().slice(0, 8).toUpperCase()}`),
        timezone: 'Mars/Olympus_Mons',
      },
    }),
    400,
    'INVALID_TIMEZONE',
  );
  await expectError(
    await api('/v1/platform/vendors?limit=101', productOwnerToken),
    400,
  );
  await expectError(
    await api('/v1/platform/vendors?cursor=not-a-cursor', productOwnerToken),
    400,
    'INVALID_CURSOR',
  );
  await expectError(await fetch(`${baseUrl}/v1/platform/vendors`), 401, 'UNAUTHENTICATED');

  await ownerPool.query('UPDATE vendors SET deleted_at = now() WHERE id = $1', [first.id]);
  const list = (await (
    await api(`/v1/platform/vendors?status=pending_approval`, productOwnerToken)
  ).json()) as { items: Array<{ id: string }> };
  assert.ok(!list.items.some(({ id }) => id === first.id));
  await expectError(
    await api(`/v1/platform/vendors/${String(first.id)}`, productOwnerToken),
    404,
    'VENDOR_NOT_FOUND',
  );
});

void test('cursor pagination defaults to 25 and has no gaps or duplicates for equal timestamps', async () => {
  const createdAt = new Date('2099-07-18T12:00:00.000Z');
  const ids = Array.from({ length: 27 }, () => randomUUID()).sort().reverse();
  vendorIds.push(...ids);
  for (const [index, id] of ids.entries()) {
    await ownerPool.query(
      `INSERT INTO vendors
         (id, code, legal_name, display_name, status, timezone, currency,
          skip_cutoff_minutes, billing_day, created_at, updated_at)
       VALUES ($1, $2, 'Page Vendor', 'Page Vendor', 'pending_approval', 'Asia/Kolkata',
               'INR', 0, 1, $3, $3)`,
      [id, `PAGE_${id.replaceAll('-', '').slice(0, 20).toUpperCase()}_${index}`, createdAt],
    );
  }
  const firstResponse = await api(
    '/v1/platform/vendors?status=pending_approval',
    productOwnerToken,
  );
  assert.equal(firstResponse.status, 200);
  const first = (await firstResponse.json()) as {
    items: Array<Record<string, unknown>>;
    nextCursor?: string;
  };
  assert.equal(first.items.length, 25);
  assert.ok(first.nextCursor);
  assert.ok(first.items.every((item) => item.status === 'pending_approval'));
  assert.ok(first.items.every((item) => Object.keys(item).sort().join() === responseKeys.join()));

  const secondResponse = await api(
    `/v1/platform/vendors?status=pending_approval&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    productOwnerToken,
  );
  assert.equal(secondResponse.status, 200);
  const second = (await secondResponse.json()) as {
    items: Array<{ id: string }>;
    nextCursor?: string;
  };
  assert.equal(second.items.length, 2);
  assert.deepEqual(
    [...first.items.map(({ id }) => String(id)), ...second.items.map(({ id }) => id)],
    ids,
  );
});

void test('cursor pagination preserves rows that arrive within the same millisecond', async () => {
  const ids = Array.from({ length: 3 }, () => randomUUID()).sort().reverse();
  vendorIds.push(...ids);
  const timestamps = [
    '2100-07-18T12:00:00.123900Z',
    '2100-07-18T12:00:00.123800Z',
    '2100-07-18T12:00:00.123700Z',
  ];
  for (const [index, id] of ids.entries()) {
    await ownerPool.query(
      `INSERT INTO vendors
         (id, code, legal_name, display_name, status, timezone, currency,
          skip_cutoff_minutes, billing_day, created_at, updated_at)
       VALUES ($1, $2, 'Precision Vendor', 'Precision Vendor', 'pending_approval',
               'Asia/Kolkata', 'INR', 0, 1, $3::timestamptz, $3::timestamptz)`,
      [id, `PRECISION_${id.replaceAll('-', '').slice(0, 20).toUpperCase()}`, timestamps[index]],
    );
  }
  let cursor: string | undefined;
  const collected: string[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const response = await api(
      `/v1/platform/vendors?status=pending_approval&limit=1${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      productOwnerToken,
    );
    assert.equal(response.status, 200);
    const page = (await response.json()) as {
      items: Array<{ id: string }>;
      nextCursor?: string;
    };
    assert.equal(page.items.length, 1, JSON.stringify(page));
    collected.push(page.items[0].id);
    cursor = page.nextCursor;
    if (index < ids.length - 1) assert.ok(cursor);
  }
  assert.deepEqual(collected, ids);
});

void test('audit failure rolls back create and OpenAPI publishes secured explicit contracts', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  const trigger = `reject_vendor_create_audit_${suffix}`;
  const triggerFunction = `reject_vendor_create_audit_fn_${suffix}`;
  const correlationId = randomUUID();
  const code = `ROLLBACK_${randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    await ownerPool.query(
      `CREATE FUNCTION ${triggerFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.correlation_id = '${correlationId}'::uuid THEN
           RAISE EXCEPTION 'forced vendor create audit failure';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await ownerPool.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events
       FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}()`,
    );
    await expectError(
      await api('/v1/platform/vendors', administratorToken, {
        method: 'POST',
        body: createBody(code),
        correlationId,
      }),
      500,
      'INTERNAL_ERROR',
    );
    assert.equal(
      (await ownerPool.query('SELECT id FROM vendors WHERE code = $1', [code])).rowCount,
      0,
    );
  } finally {
    await ownerPool.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit_events`);
    await ownerPool.query(`DROP FUNCTION IF EXISTS ${triggerFunction}()`);
  }

  const response = await fetch(`${baseUrl}/openapi.json`);
  assert.equal(response.status, 200);
  const document = (await response.json()) as {
    components?: { securitySchemes?: Record<string, unknown>; schemas?: Record<string, unknown> };
    paths?: Record<string, Record<string, { security?: unknown; responses?: unknown }>>;
  };
  assert.ok(document.components?.securitySchemes?.opaqueBearer);
  for (const [path, method] of [
    ['/v1/platform/vendors', 'post'],
    ['/v1/platform/vendors', 'get'],
    ['/v1/platform/vendors/{id}', 'get'],
    ['/v1/platform/vendors/{id}/transitions', 'post'],
    ['/v1/vendors/{vendorId}/profile', 'get'],
  ] as const) {
    const operation = document.paths?.[path]?.[method];
    assert.ok(operation?.security);
    assert.ok(operation.responses);
  }
  assert.ok(document.components?.schemas?.VendorResponseDto);
  assert.ok(document.components?.schemas?.ApiErrorResponseDto);
});
