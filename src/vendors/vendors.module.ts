import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { TransitionVendor } from './application/transition-vendor.js';
import { PrismaVendorStore } from './infrastructure/prisma-vendor.store.js';

@Module({
  imports: [AuditModule, DatabaseModule],
  providers: [PrismaVendorStore, TransitionVendor],
  exports: [TransitionVendor],
})
export class VendorsModule {}
