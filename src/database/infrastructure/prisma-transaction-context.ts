import type { TransactionContext } from '../../common/application/transaction-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import type { Prisma } from '../../generated/prisma/client.js';

const transactions = new WeakMap<TransactionContext, Prisma.TransactionClient>();

export const wrapPrismaTransaction = (
  transaction: Prisma.TransactionClient,
): TransactionContext => {
  const context = Object.freeze({}) as TransactionContext;
  transactions.set(context, transaction);
  return context;
};

export const unwrapPrismaTransaction = (
  context: TransactionContext,
): Prisma.TransactionClient => {
  const transaction = transactions.get(context);
  if (!transaction) {
    throw new ApplicationError(
      'INVALID_TRANSACTION_CONTEXT',
      'Transaction context is invalid',
      500,
    );
  }
  return transaction;
};
