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
