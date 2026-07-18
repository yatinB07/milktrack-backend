import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  PlatformPermission,
  VendorPermission,
} from '../src/authorization/application/authorization.policy.js';
import {
  requirePlatformPermission,
  requireVendorPermission,
} from '../src/authorization/application/authorization.policy.js';
import type { AuditWriter } from '../src/audit/application/audit-writer.js';
import { PrismaAuthorizationPolicy } from '../src/authorization/infrastructure/prisma-authorization.policy.js';
import type {
  Actor,
  PlatformRole,
  VendorRole,
} from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import type { Prisma } from '../src/generated/prisma/client.js';

const platform = {
  product_owner: ['vendor:read'],
  platform_administrator: [
    'vendor:read',
    'vendor:create',
    'vendor:transition',
    'platform-role:manage',
  ],
  support_operations: [],
} as const satisfies Readonly<Record<PlatformRole, readonly PlatformPermission[]>>;

const vendor = {
  vendor_owner: ['membership:read', 'membership:manage', 'audit:read'],
  vendor_administrator: ['membership:read', 'membership:manage', 'audit:read'],
  delivery_agent: ['delivery:read', 'delivery:record'],
  customer: ['customer:self'],
} as const satisfies Readonly<Record<VendorRole, readonly VendorPermission[]>>;

const forbidden = (error: unknown) =>
  error instanceof ApplicationError &&
  error.code === 'FORBIDDEN' &&
  error.message === 'You are not allowed to perform this action' &&
  error.status === 403;

void test('platform roles allow exactly the reviewed permission matrix', () => {
  for (const [role, permissions] of Object.entries(platform)) {
    for (const permission of permissions) {
      assert.doesNotThrow(() =>
        requirePlatformPermission(role as PlatformRole, permission),
      );
    }
  }

  assert.throws(
    () => requirePlatformPermission('product_owner', 'vendor:create'),
    forbidden,
  );
  assert.throws(
    () => requirePlatformPermission('platform_administrator', 'customer:self' as PlatformPermission),
    forbidden,
  );
  assert.throws(
    () => requirePlatformPermission('support_operations', 'vendor:read'),
    forbidden,
  );
});

void test('vendor roles allow exactly the reviewed permission matrix', () => {
  for (const [role, permissions] of Object.entries(vendor)) {
    for (const permission of permissions) {
      assert.doesNotThrow(() =>
        requireVendorPermission(role as VendorRole, permission),
      );
    }
  }

  assert.throws(
    () => requireVendorPermission('vendor_owner', 'delivery:record'),
    forbidden,
  );
  assert.throws(
    () => requireVendorPermission('vendor_administrator', 'customer:self'),
    forbidden,
  );
  assert.throws(
    () => requireVendorPermission('delivery_agent', 'membership:read'),
    forbidden,
  );
  assert.throws(
    () => requireVendorPermission('customer', 'audit:read'),
    forbidden,
  );
});

void test('vendor policy grants access when any active membership role permits it', async () => {
  const audits: AuditWriter = { append: () => Promise.resolve() };
  const policy = new PrismaAuthorizationPolicy(audits);
  const actor: Actor = {
    userId: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    displayName: 'Multi-role user',
    authenticationMethod: 'administrator_mfa',
    platformRoles: [],
    memberships: [],
  };
  const tx = {
    vendor: {
      findFirst: () => Promise.resolve({ id: actor.userId }),
    },
    vendorMembership: {
      findFirst: () => Promise.resolve({ role: 'customer' }),
      findMany: () =>
        Promise.resolve([
          { role: 'customer' },
          { role: 'vendor_administrator' },
        ]),
    },
  } as unknown as Prisma.TransactionClient;

  await assert.doesNotReject(
    policy.requireVendor(
      tx,
      actor,
      actor.userId,
      'membership:read',
      'membership.list',
    ),
  );
});
