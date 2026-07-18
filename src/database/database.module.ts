import { Module } from '@nestjs/common';

import { TenantTransactionRunner } from '../common/application/transaction-context.js';
import { PrismaService } from './infrastructure/prisma.service.js';
import { PrismaTenantTransactionRunner } from './infrastructure/prisma-tenant-transaction.runner.js';

@Module({
  providers: [
    PrismaService,
    PrismaTenantTransactionRunner,
    { provide: TenantTransactionRunner, useExisting: PrismaTenantTransactionRunner },
  ],
  exports: [PrismaService, TenantTransactionRunner],
})
export class DatabaseModule {}
