import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  PlatformPermission,
  VendorPermission,
} from '../src/authorization/application/authorization.policy.js';
import {
  requirePlatformPermission,
  requireVendorOperation,
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
import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';

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
  vendor_owner: [
    'membership:read',
    'membership:manage',
    'audit:read',
    'vendor:profile:read',
    'household:read',
    'household:manage',
    'catalog:read',
    'catalog:manage',
    'pricing:read',
    'pricing:manage',
    'subscription:read',
    'subscription:manage',
  ],
  vendor_administrator: [
    'membership:read',
    'membership:manage',
    'audit:read',
    'vendor:profile:read',
    'household:read',
    'household:manage',
    'catalog:read',
    'catalog:manage',
    'pricing:read',
    'pricing:manage',
    'subscription:read',
    'subscription:manage',
  ],
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
    () => requireVendorPermission('delivery_agent', 'vendor:profile:read'),
    forbidden,
  );
  assert.throws(
    () => requireVendorPermission('customer', 'audit:read'),
    forbidden,
  );
  assert.throws(
    () => requireVendorPermission('customer', 'vendor:profile:read'),
    forbidden,
  );
  assert.doesNotThrow(() => requireVendorPermission('vendor_owner', 'household:manage'));
  assert.doesNotThrow(() => requireVendorPermission('vendor_administrator', 'household:read'));
  assert.doesNotThrow(() => requireVendorPermission('customer', 'customer:self'));
  assert.throws(() => requireVendorPermission('delivery_agent', 'household:read'), forbidden);
  assert.throws(() => requireVendorPermission('customer', 'household:manage'), forbidden);
  assert.throws(() => requireVendorPermission('delivery_agent', 'catalog:read'), forbidden);
  assert.throws(() => requireVendorPermission('customer', 'catalog:manage'), forbidden);
  assert.throws(() => requireVendorPermission('customer', 'pricing:read'), forbidden);
  assert.throws(() => requireVendorPermission('customer', 'pricing:manage'), forbidden);
});

void test('catalog operations map only to the reviewed read and manage permissions', () => {
  for (const operation of [
    'catalog.unit-list',
    'catalog.unit-get',
    'catalog.product-list',
    'catalog.product-get',
    'catalog.delivery-slot-list',
    'catalog.delivery-slot-get',
  ]) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'catalog:read'));
    assert.throws(() => requireVendorOperation(operation, 'catalog:manage'), forbidden);
  }
  for (const operation of [
    'catalog.unit-create',
    'catalog.unit-rename',
    'catalog.unit-deactivate',
    'catalog.unit-reactivate',
    'catalog.product-create',
    'catalog.product-update',
    'catalog.product-delete',
    'catalog.product-restore',
    'catalog.delivery-slot-create',
    'catalog.delivery-slot-rename',
    'catalog.delivery-slot-deactivate',
    'catalog.delivery-slot-reactivate',
  ]) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'catalog:manage'));
    assert.throws(() => requireVendorOperation(operation, 'catalog:read'), forbidden);
  }
  assert.throws(() => requireVendorOperation('catalog.product-status', 'catalog:manage'), forbidden);
});

void test('pricing operations map only to explicit read, manage, and customer-self permissions', () => {
  for (const operation of [
    'pricing.global-list', 'pricing.global-get',
    'pricing.override-list', 'pricing.override-get', 'pricing.resolve',
  ]) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'pricing:read'));
    assert.throws(() => requireVendorOperation(operation, 'pricing:manage'), forbidden);
    assert.throws(() => requireVendorOperation(operation, 'customer:self'), forbidden);
  }
  for (const operation of [
    'pricing.global-create', 'pricing.global-close',
    'pricing.override-create', 'pricing.override-close',
  ]) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'pricing:manage'));
    assert.throws(() => requireVendorOperation(operation, 'pricing:read'), forbidden);
  }
  assert.doesNotThrow(() => requireVendorOperation('pricing.self-resolve', 'customer:self'));
  assert.throws(() => requireVendorOperation('pricing.self-resolve', 'pricing:read'), forbidden);
  assert.throws(() => requireVendorOperation('pricing.global-update', 'pricing:manage'), forbidden);
});

void test('subscription operations map to explicit read, manage, and customer-self permissions', () => {
  for (const operation of ['subscription.list', 'subscription.get', 'subscription.history']) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'subscription:read'));
    assert.throws(() => requireVendorOperation(operation, 'subscription:manage'), forbidden);
  }
  for (const operation of [
    'subscription.create', 'subscription.modify', 'subscription.pause', 'subscription.resume',
    'subscription.cancel', 'subscription.delete', 'subscription.restore',
  ]) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'subscription:manage'));
    assert.throws(() => requireVendorOperation(operation, 'subscription:read'), forbidden);
  }
  for (const operation of ['subscription.self-list', 'subscription.self-get', 'subscription.self-history']) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'customer:self'));
    assert.throws(() => requireVendorOperation(operation, 'subscription:read'), forbidden);
  }
  assert.throws(() => requireVendorPermission('customer', 'subscription:read'), forbidden);
  assert.throws(() => requireVendorPermission('delivery_agent', 'subscription:read'), forbidden);
});

void test('route definition operations map only to explicit read and manage permissions', () => {
  for (const operation of ['route.list', 'route.get']) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'route:read'));
    assert.throws(() => requireVendorOperation(operation, 'route:manage'), forbidden);
  }
  for (const operation of ['route.create', 'route.rename', 'route.deactivate', 'route.reactivate', 'route.delete', 'route.restore']) {
    assert.doesNotThrow(() => requireVendorOperation(operation, 'route:manage'));
    assert.throws(() => requireVendorOperation(operation, 'route:read'), forbidden);
  }
  assert.doesNotThrow(() => requireVendorPermission('vendor_owner', 'route:manage'));
  assert.doesNotThrow(() => requireVendorPermission('vendor_administrator', 'route:read'));
  assert.throws(() => requireVendorPermission('delivery_agent', 'route:read'), forbidden);
  assert.throws(() => requireVendorPermission('customer', 'route:read'), forbidden);
});

void test('catalog vendor operations accept onboarding, trial, and active vendors', async () => {
  const statuses: string[][] = [];
  const audits: AuditWriter = { append: () => Promise.resolve() };
  const policy = new PrismaAuthorizationPolicy(audits);
  const actor: Actor = {
    userId: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    displayName: 'Catalog administrator',
    authenticationMethod: 'administrator_mfa',
    platformRoles: [],
    memberships: [],
  };
  const tx = {
    vendor: {
      findFirst: ({ where }: { where: { status: { in: string[] } } }) => {
        statuses.push(where.status.in);
        return Promise.resolve({ id: actor.userId });
      },
    },
    vendorMembership: {
      findMany: () => Promise.resolve([{ role: 'vendor_administrator' }]),
    },
  } as unknown as Prisma.TransactionClient;

  await policy.requireVendor(
    wrapPrismaTransaction(tx),
    actor,
    actor.userId,
    'catalog:manage',
    'catalog.product-update',
  );
  assert.deepEqual(statuses, [['onboarding', 'trial', 'active']]);
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
      wrapPrismaTransaction(tx),
      actor,
      actor.userId,
      'membership:read',
      'membership.list',
    ),
  );
});
