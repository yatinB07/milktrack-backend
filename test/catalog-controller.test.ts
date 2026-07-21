import assert from 'node:assert/strict';
import test from 'node:test';

import { validate } from 'class-validator';

import type {
  TenantAuthorizationExecutor,
  TenantAuthorizationInput,
} from '../src/authorization/application/tenant-authorization.executor.js';
import {
  CatalogService,
  PrismaCatalogService,
} from '../src/catalog/application/catalog.service.js';
import {
  ProductPageQueryDto,
} from '../src/catalog/http/catalog.dto.js';
import { ProductController } from '../src/catalog/http/product.controller.js';
import { UnitController } from '../src/catalog/http/unit.controller.js';
import { PrismaCatalogStore } from '../src/catalog/infrastructure/prisma-catalog.store.js';
import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { requestContextStore, type Actor } from '../src/common/context/request-context.js';
import { LifecycleQueryDto } from '../src/common/http/record-lifecycle.dto.js';

const actor: Actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  displayName: 'Catalog administrator',
  authenticationMethod: 'administrator_mfa',
  platformRoles: [],
  memberships: [],
};
const now = new Date('2026-07-20T10:00:00.000Z');

void test('catalog controllers map application dates and preserve product versions', async () => {
  const unit = {
    id: '00000000-0000-4000-8000-000000000010',
    vendorId: '00000000-0000-4000-8000-000000000020',
    code: 'LTR',
    name: 'Litre',
    decimalScale: 2,
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
  };
  const product = {
    id: '00000000-0000-4000-8000-000000000030',
    vendorId: unit.vendorId,
    code: 'MILK',
    name: 'Milk',
    defaultUnitId: unit.id,
    status: 'active' as const,
    version: 1,
    lifecycle: 'current' as const,
    createdAt: now,
    updatedAt: now,
  };
  const service = {
    createUnit: () => Promise.resolve(unit),
    createProduct: () => Promise.resolve(product),
  } as unknown as CatalogService;

  const responses = await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000040', actor },
    async () => [
      await new UnitController(service).create(unit.vendorId, {
        code: 'ltr', name: ' Litre ', decimalScale: 2,
      }),
      await new ProductController(service).create(product.vendorId, {
        code: 'milk', name: ' Milk ', defaultUnitId: unit.id,
      }),
    ],
  );

  assert.deepEqual(responses, [
    { ...unit, createdAt: now.toISOString(), updatedAt: now.toISOString() },
    { ...product, createdAt: now.toISOString(), updatedAt: now.toISOString() },
  ]);
});

void test('unit lifecycle POST actions explicitly return HTTP 200', () => {
  for (const method of ['deactivate', 'reactivate']) {
    const handler = Object.getOwnPropertyDescriptor(UnitController.prototype, method)?.value as object;
    assert.equal(Reflect.getMetadata('__httpCode__', handler), 200);
  }
});

void test('product controller normalizes lifecycle and exposes runtime DTO metadata', async () => {
  const calls: unknown[][] = [];
  const product = {
    id: '00000000-0000-4000-8000-000000000030',
    vendorId: '00000000-0000-4000-8000-000000000020',
    code: 'MILK',
    name: 'Milk',
    defaultUnitId: '00000000-0000-4000-8000-000000000010',
    status: 'inactive' as const,
    version: 3,
    lifecycle: 'deleted' as const,
    createdAt: now,
    updatedAt: now,
  };
  const service = {
    listProducts: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ items: [{ ...product, lifecycle: 'current' }] });
    },
    getProduct: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(product);
    },
  } as unknown as CatalogService;
  const controller = new ProductController(service);

  await requestContextStore.run(
    { correlationId: '00000000-0000-4000-8000-000000000040', actor },
    async () => {
      const page = await controller.list(product.vendorId, new ProductPageQueryDto());
      assert.equal(page.items[0]?.lifecycle, 'current');
      const detail = await controller.get(
        product.vendorId,
        product.id,
        Object.assign(new LifecycleQueryDto(), { lifecycle: 'deleted' }),
      );
      assert.equal(detail.lifecycle, 'deleted');
    },
  );

  assert.equal((calls[0]?.[2] as { lifecycle?: string }).lifecycle, 'current');
  assert.equal(calls[1]?.[3], 'deleted');
  assert.deepEqual(
    Reflect.getMetadata('design:paramtypes', ProductController.prototype, 'list'),
    [String, ProductPageQueryDto],
  );
  assert.deepEqual(
    Reflect.getMetadata('design:paramtypes', ProductController.prototype, 'get'),
    [String, String, LifecycleQueryDto],
  );
});

void test('product lifecycle query rejects unsupported values', async () => {
  const query = Object.assign(new ProductPageQueryDto(), { lifecycle: 'all' });
  const errors = await validate(query);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.property, 'lifecycle');
});

void test('product service selects lifecycle authorization and redacts deletion metadata', async () => {
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
    id: '00000000-0000-4000-8000-000000000030',
    vendorId: '00000000-0000-4000-8000-000000000020',
    code: 'MILK',
    name: 'Milk',
    defaultUnitId: '00000000-0000-4000-8000-000000000010',
    status: 'inactive' as const,
    version: 3,
    deletedAt: new Date('2026-07-21T00:00:00Z'),
    deletedBy: actor.userId,
    deletionReason: 'Archived',
    createdAt: now,
    updatedAt: now,
  };
  const store = {
    listProducts: (_tx: TransactionContext, query: unknown) => {
      assert.deepEqual(query, { lifecycle: 'deleted', search: undefined });
      return Promise.resolve({ items: [deleted] });
    },
    getProduct: (_tx: TransactionContext, _id: string, lifecycle: string) => {
      assert.equal(lifecycle, 'current');
      return Promise.resolve({ ...deleted, deletedAt: null });
    },
  } as unknown as PrismaCatalogStore;
  const service = new PrismaCatalogService(
    authorization,
    store,
    {} as never,
  );

  const page = await service.listProducts(actor, deleted.vendorId, {
    lifecycle: 'deleted',
  });
  assert.deepEqual(page.items, [{
    id: deleted.id,
    vendorId: deleted.vendorId,
    code: deleted.code,
    name: deleted.name,
    defaultUnitId: deleted.defaultUnitId,
    status: deleted.status,
    version: deleted.version,
    createdAt: deleted.createdAt,
    updatedAt: deleted.updatedAt,
    lifecycle: 'deleted',
  }]);
  assert.deepEqual(
    { permission: requests[0]?.permission, operation: requests[0]?.operation },
    { permission: 'catalog:manage', operation: 'catalog.product-deleted-list' },
  );

  const detail = await service.getProduct(
    actor,
    deleted.vendorId,
    deleted.id,
    'current',
  );
  assert.equal(detail.status, 'inactive');
  assert.equal(detail.lifecycle, 'current');
  assert.deepEqual(
    { permission: requests[1]?.permission, operation: requests[1]?.operation },
    { permission: 'catalog:read', operation: 'catalog.product-get' },
  );
});
