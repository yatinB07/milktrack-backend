import { Inject, Injectable } from '@nestjs/common';

import {
  TenantTransactionRunner,
  type TransactionContext,
} from '../../common/application/transaction-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { PrismaService } from './prisma.service.js';
import { wrapPrismaTransaction } from './prisma-transaction-context.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class PrismaTenantTransactionRunner extends TenantTransactionRunner {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  run<T>(
    vendorId: string,
    operation: (context: TransactionContext) => Promise<T>,
  ): Promise<T> {
    if (!UUID_PATTERN.test(vendorId)) {
      throw new ApplicationError(
        'INVALID_TENANT',
        'Vendor context is invalid',
        403,
      );
    }
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.vendor_id', ${vendorId}, true)`;
      return operation(wrapPrismaTransaction(transaction));
    });
  }
}
