import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { ScheduleDateLock } from '../application/schedule-date-lock.js';

@Injectable()
export class PrismaScheduleDateLock extends ScheduleDateLock {
  async lock(
    transaction: TransactionContext,
    vendorId: string,
    serviceDates: string[],
  ): Promise<void> {
    const prisma = unwrapPrismaTransaction(transaction);
    for (const serviceDate of [...new Set(serviceDates)].sort()) {
      await prisma.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`scheduling-vendor-date:${vendorId}:${serviceDate}`}, 0))
      `;
    }
  }
}
