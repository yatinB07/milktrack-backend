import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PrismaIdentityAuthorizationAdapter } from '../src/authorization/infrastructure/prisma-identity-authorization.adapter.js';
import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import { PrismaIdentityStore } from '../src/identity/infrastructure/prisma-identity.store.js';
import type { Prisma } from '../src/generated/prisma/client.js';

const context = (transaction: object) =>
  wrapPrismaTransaction(transaction as Prisma.TransactionClient);

void test('authentication authority lookups use constant database calls and exact fields', async () => {
  const calls: string[] = [];
  const transaction = {
    vendor: { findMany: () => { throw new Error('must not scan vendors'); } },
    platformRoleAssignment: {
      findMany: () => {
        calls.push('platform');
        return Promise.resolve([{ role: 'product_owner' }]);
      },
    },
    $queryRaw: () => {
      calls.push('function');
      return Promise.resolve([{
        membership_id: '10000000-0000-4000-8000-000000000001',
        vendor_id: '10000000-0000-4000-8000-000000000002',
        vendor_name: 'Vendor A',
        membership_role: 'customer',
        membership_status: 'active',
      }]);
    },
  };

  const result = await new PrismaIdentityAuthorizationAdapter().snapshot(
    context(transaction),
    '10000000-0000-4000-8000-000000000003',
    ['trial', 'active'],
  );

  assert.deepEqual(calls, ['platform', 'function']);
  assert.deepEqual(result, {
    platformRoles: ['product_owner'],
    memberships: [{
      id: '10000000-0000-4000-8000-000000000001',
      vendorId: '10000000-0000-4000-8000-000000000002',
      vendorName: 'Vendor A',
      role: 'customer',
      status: 'active',
    }],
  });
});

void test('phone membership existence and activation each use one database function call', async () => {
  const adapter = new PrismaIdentityAuthorizationAdapter();
  let calls = 0;
  const hasTransaction = {
    vendor: { findMany: () => { throw new Error('must not scan vendors'); } },
    $queryRaw: () => { calls += 1; return Promise.resolve([{ has_membership: true }]); },
  };
  assert.equal(await adapter.hasPhoneMembership(
    context(hasTransaction),
    '10000000-0000-4000-8000-000000000003',
    ['active'],
  ), true);
  assert.equal(calls, 1);

  const activationTransaction = {
    vendor: { findMany: () => { throw new Error('must not scan vendors'); } },
    $queryRaw: () => {
      calls += 1;
      return Promise.resolve([
        { membership_id: '10000000-0000-4000-8000-000000000001', vendor_id: '10000000-0000-4000-8000-000000000002' },
        { membership_id: '10000000-0000-4000-8000-000000000004', vendor_id: '10000000-0000-4000-8000-000000000005' },
      ]);
    },
  };
  assert.equal(await adapter.activateInvitedPhoneMemberships(
    context(activationTransaction),
    {
      userId: '10000000-0000-4000-8000-000000000003',
      at: new Date('2030-01-01T00:00:00Z'),
      correlationId: '10000000-0000-4000-8000-000000000006',
    },
  ), 2);
  assert.equal(calls, 2);
});

void test('unknown users short-circuit before authority lookup', async () => {
  let authorityCalls = 0;
  const receiver = {
    authority: {
      hasPhoneMembership: () => { authorityCalls += 1; return Promise.resolve(false); },
      snapshot: () => { authorityCalls += 1; return Promise.resolve({ platformRoles: [], memberships: [] }); },
    },
  };
  const operation = PrismaIdentityStore.prototype as unknown as {
    isEligiblePhoneUser(
      this: typeof receiver,
      tx: object,
      userId: string,
      statuses?: readonly ('active' | 'invited')[],
    ): Promise<boolean>;
  };
  const eligible = await operation.isEligiblePhoneUser.call(
    receiver,
    { user: { findFirst: () => Promise.resolve(null) } },
    '10000000-0000-4000-8000-000000000003',
  );
  assert.equal(eligible, false);
  assert.equal(authorityCalls, 0);
});

void test('migration defines only narrow authentication functions and the partial auth index', async () => {
  const migration = await readFile(
    'prisma/migrations/202607210001_authentication_authority_lookup/migration.sql',
    'utf8',
  );
  for (const name of [
    'has_phone_auth_membership',
    'authentication_authority_memberships',
    'activate_invited_phone_memberships',
  ]) {
    assert.match(migration, new RegExp(`CREATE FUNCTION "${name}"`));
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION "${name}"[\\s\\S]+FROM PUBLIC`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION "${name}"[\\s\\S]+TO milktrack_app`));
  }
  assert.equal((migration.match(/SECURITY DEFINER/g) ?? []).length, 3);
  assert.equal((migration.match(/SET search_path = pg_catalog, public/g) ?? []).length, 3);
  assert.match(migration, /ON "vendor_memberships"\("user_id", "status", "vendor_id"\)/);
  assert.match(migration, /WHERE "ended_at" IS NULL AND "deleted_at" IS NULL/);
  assert.doesNotMatch(migration, /requested_vendor_id|SELECT \*/);
});
