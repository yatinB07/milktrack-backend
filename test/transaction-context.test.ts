import assert from 'node:assert/strict';
import test from 'node:test';

import type { TransactionContext } from '../src/common/application/transaction-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import {
  unwrapPrismaTransaction,
  wrapPrismaTransaction,
} from '../src/database/infrastructure/prisma-transaction-context.js';
import type { Prisma } from '../src/generated/prisma/client.js';

void test('transaction context exposes no Prisma properties or methods', () => {
  const transaction = { vendor: {}, $queryRaw: () => undefined } as unknown as
    Prisma.TransactionClient;
  const context = wrapPrismaTransaction(transaction);

  assert.deepEqual(Reflect.ownKeys(context), []);
  assert.equal('vendor' in context, false);
  assert.equal('$queryRaw' in context, false);
  assert.equal(unwrapPrismaTransaction(context), transaction);
});

void test('transaction context rejects a forged handle with a stable internal error', () => {
  assert.throws(
    () => unwrapPrismaTransaction({} as TransactionContext),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'INVALID_TRANSACTION_CONTEXT' &&
      error.status === 500,
  );
});
