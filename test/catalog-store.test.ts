import assert from 'node:assert/strict';
import test from 'node:test';

import { CursorCodec } from '../src/common/cursor/cursor.js';
import { wrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaCatalogStore } from '../src/catalog/infrastructure/prisma-catalog.store.js';

void test('unit search remains applied on cursor pages', async () => {
  let where: unknown;
  const tx = {
    unit: {
      findMany: (input: { where: unknown }) => {
        where = input.where;
        return Promise.resolve([]);
      },
    },
  } as unknown as Prisma.TransactionClient;
  const cursor = new CursorCodec().encode({
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    id: '00000000-0000-4000-8000-000000000001',
  });

  await new PrismaCatalogStore().listUnits(wrapPrismaTransaction(tx), {
    cursor,
    search: 'milk',
    status: 'inactive',
  });

  assert.deepEqual(where, {
    status: 'inactive',
    OR: [
      { code: { contains: 'milk', mode: 'insensitive' } },
      { name: { contains: 'milk', mode: 'insensitive' } },
    ],
    AND: [{
      OR: [
        { createdAt: { lt: new Date('2026-07-20T10:00:00.000Z') } },
        {
          createdAt: new Date('2026-07-20T10:00:00.000Z'),
          id: { lt: '00000000-0000-4000-8000-000000000001' },
        },
      ],
    }],
  });
});

void test('product store applies lifecycle and status predicates without changing cursor order', async () => {
  const where: unknown[] = [];
  const orderBy: unknown[] = [];
  const row = {
    id: '00000000-0000-4000-8000-000000000030',
    vendorId: '00000000-0000-4000-8000-000000000020',
    code: 'MILK',
    name: 'Milk',
    defaultUnitId: '00000000-0000-4000-8000-000000000010',
    status: 'inactive' as const,
    version: 3,
    deletedAt: new Date('2026-07-21T10:00:00.000Z'),
    deletedBy: null,
    deletionReason: null,
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    updatedAt: new Date('2026-07-20T10:00:00.000Z'),
  };
  const tx = {
    product: {
      findMany: (input: { where: unknown; orderBy: unknown }) => {
        where.push(input.where);
        orderBy.push(input.orderBy);
        return Promise.resolve([]);
      },
      findFirst: (input: { where: unknown }) => {
        where.push(input.where);
        return Promise.resolve(row);
      },
    },
  } as unknown as Prisma.TransactionClient;
  const context = wrapPrismaTransaction(tx);
  const store = new PrismaCatalogStore();

  await store.listProducts(context, { lifecycle: 'current' });
  await store.listProducts(context, { lifecycle: 'deleted' });
  await store.listProducts(context, { lifecycle: 'deleted', status: 'active' });
  const detail = await store.getProduct(context, row.id, 'deleted');

  assert.deepEqual(where, [
    { deletedAt: null, status: 'active' },
    { deletedAt: { not: null } },
    { deletedAt: { not: null }, status: 'active' },
    { id: row.id, deletedAt: { not: null } },
  ]);
  assert.deepEqual(orderBy, [
    [{ createdAt: 'desc' }, { id: 'desc' }],
    [{ createdAt: 'desc' }, { id: 'desc' }],
    [{ createdAt: 'desc' }, { id: 'desc' }],
  ]);
  assert.equal(detail.status, 'inactive');
  assert.equal(detail.deletedAt, row.deletedAt);
});
