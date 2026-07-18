import { Injectable } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client.js';
import { ApplicationError } from '../common/errors/application.error.js';
import { PrismaService } from './prisma.service.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TenantTransactionRunner {
  run<T>(
    vendorId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
}

@Injectable()
export class PrismaTenantTransactionRunner implements TenantTransactionRunner {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(
    vendorId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!UUID_PATTERN.test(vendorId)) {
      throw new ApplicationError(
        'INVALID_TENANT',
        'Vendor context is invalid',
        403,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.vendor_id', ${vendorId}, true)`;
      return operation(tx);
    });
  }
}
