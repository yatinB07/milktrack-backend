import assert from 'node:assert/strict';
import test from 'node:test';

import { validate } from 'class-validator';

import type {
  TenantAuthorizationExecutor,
  TenantAuthorizationInput,
} from '../src/authorization/application/tenant-authorization.executor.js';
import type { TransactionContext } from '../src/common/application/transaction-context.js';
import {
  requestContextStore,
  type Actor,
} from '../src/common/context/request-context.js';
import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import {
  HouseholdService,
  PrismaHouseholdService,
} from '../src/customers/application/household.service.js';
import {
  HouseholdController,
} from '../src/customers/http/household.controller.js';
import {
  HouseholdDiscoveryQueryDto,
} from '../src/customers/http/household.dto.js';
import { PrismaHouseholdStore } from '../src/customers/infrastructure/prisma-household.store.js';
import { LifecycleQueryDto } from '../src/common/http/record-lifecycle.dto.js';

const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Owner',
  authenticationMethod: 'administrator_mfa',
  platformRoles: [],
  memberships: [],
};
const household = {
  id: '00000000-0000-4000-8000-000000000003',
  vendorId: '00000000-0000-4000-8000-000000000004',
  accountNumber: 'HH-1',
  name: 'Household',
  addressLine1: 'Road',
  city: 'City',
  region: 'Region',
  postalCode: '12345',
  countryCode: 'IN',
  status: 'active' as const,
  version: 1,
  createdAt: new Date('2026-07-20T00:00:00Z'),
  updatedAt: new Date('2026-07-20T00:00:00Z'),
};

void test('household controller normalizes lifecycle and maps the public response', async () => {
  const calls: unknown[][] = [];
  const service = {
    list: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ items: [{ ...household, lifecycle: 'current' }] });
    },
    get: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ ...household, lifecycle: 'deleted' });
    },
    create: () => Promise.resolve({ ...household, lifecycle: 'current' }),
  } as unknown as HouseholdService;
  const controller = new HouseholdController(service);

  await requestContextStore.run(
    {
      correlationId: '00000000-0000-4000-8000-000000000005',
      actor,
    },
    async () => {
      const created = await controller.create(household.vendorId, household);
      assert.deepEqual(created, {
        ...household,
        lifecycle: 'current',
        createdAt: household.createdAt.toISOString(),
        updatedAt: household.updatedAt.toISOString(),
      });
      const page = await controller.list(
        household.vendorId,
        new HouseholdDiscoveryQueryDto(),
      );
      assert.equal(page.items[0]?.lifecycle, 'current');
      const detail = await controller.get(
        household.vendorId,
        household.id,
        Object.assign(new LifecycleQueryDto(), { lifecycle: 'deleted' }),
      );
      assert.equal(detail.lifecycle, 'deleted');
    },
  );

  assert.equal(
    (calls[0]?.[2] as { lifecycle?: string }).lifecycle,
    'current',
  );
  assert.equal(calls[1]?.[3], 'deleted');
  assert.deepEqual(
    Reflect.getMetadata(
      'design:paramtypes',
      HouseholdController.prototype,
      'get',
    ),
    [String, String, LifecycleQueryDto],
  );
});

void test('household lifecycle query rejects unsupported values', async () => {
  const query = Object.assign(new HouseholdDiscoveryQueryDto(), {
    lifecycle: 'all',
  });
  const errors = await validate(query);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.property, 'lifecycle');
});

void test('household service selects lifecycle authorization and redacts deletion metadata', async () => {
  const requests: TenantAuthorizationInput[] = [];
  const tx = Object.freeze({}) as TransactionContext;
  const authorization: TenantAuthorizationExecutor = {
    execute<T>(
      input: TenantAuthorizationInput,
      operation: (context: TransactionContext) => Promise<T>,
    ) {
      requests.push(input);
      return operation(tx);
    },
  };
  const deleted = {
    ...household,
    deletedAt: new Date('2026-07-21T00:00:00Z'),
    deletedBy: actor.userId,
    deletionReason: 'Archived',
  };
  const store = {
    list: (_tx: TransactionContext, query: unknown) => {
      assert.deepEqual(query, { lifecycle: 'deleted', search: undefined });
      return Promise.resolve({ items: [deleted] });
    },
    get: (
      _tx: TransactionContext,
      _id: string,
      lifecycle: string,
    ) => {
      assert.equal(lifecycle, 'current');
      return Promise.resolve({ ...household, status: 'inactive' as const });
    },
  } as unknown as PrismaHouseholdStore;
  const service = new PrismaHouseholdService(
    authorization,
    store,
    {} as never,
    {} as never,
  );

  const page = await service.list(actor, household.vendorId, {
    lifecycle: 'deleted',
  });
  assert.deepEqual(page.items, [{ ...household, lifecycle: 'deleted' }]);
  assert.deepEqual(
    {
      permission: requests[0]?.permission,
      operation: requests[0]?.operation,
    },
    { permission: 'household:manage', operation: 'household.deleted-list' },
  );

  const detail = await service.get(
    actor,
    household.vendorId,
    household.id,
    'current',
  );
  assert.equal(detail.status, 'inactive');
  assert.equal(detail.lifecycle, 'current');
  assert.deepEqual(
    {
      permission: requests[1]?.permission,
      operation: requests[1]?.operation,
    },
    { permission: 'household:read', operation: 'household.get' },
  );
});

void test('household store applies lifecycle predicates without filtering detail status', async () => {
  const listWhere: unknown[] = [];
  const detailWhere: unknown[] = [];
  const row = {
    ...household,
    addressLine2: null,
    locality: null,
    latitude: null,
    longitude: null,
    notes: null,
    deletedAt: null,
    deletedBy: null,
    deletionReason: null,
    status: 'inactive' as const,
  };
  const context = wrapPrismaTransaction({
    household: {
      findMany: ({ where }: { where: unknown }) => {
        listWhere.push(where);
        return Promise.resolve([]);
      },
      findFirst: ({ where }: { where: unknown }) => {
        detailWhere.push(where);
        return Promise.resolve(row);
      },
    },
  } as never);
  const store = new PrismaHouseholdStore();

  await store.list(context, { lifecycle: 'current' });
  await store.list(context, { lifecycle: 'deleted' });
  const detail = await store.get(context, household.id, 'current');

  assert.deepEqual(listWhere[0], {
    deletedAt: null,
    status: 'active',
    AND: [],
  });
  assert.deepEqual(listWhere[1], {
    deletedAt: { not: null },
    AND: [],
  });
  assert.deepEqual(detailWhere[0], { id: household.id, deletedAt: null });
  assert.equal(detail.status, 'inactive');
});
