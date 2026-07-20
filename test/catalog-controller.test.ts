import assert from 'node:assert/strict';
import test from 'node:test';

import type { CatalogService } from '../src/catalog/application/catalog.service.js';
import { ProductController } from '../src/catalog/http/product.controller.js';
import { UnitController } from '../src/catalog/http/unit.controller.js';
import { requestContextStore, type Actor } from '../src/common/context/request-context.js';

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
