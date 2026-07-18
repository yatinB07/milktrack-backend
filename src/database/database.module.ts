import { Module } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';
import { PrismaTenantTransactionRunner } from './tenant-transaction.runner.js';

@Module({
  providers: [PrismaService, PrismaTenantTransactionRunner],
  exports: [PrismaService, PrismaTenantTransactionRunner],
})
export class DatabaseModule {}
