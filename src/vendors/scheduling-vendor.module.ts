import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { SchedulingVendorService } from './application/scheduling-vendor.service.js';
import { PrismaSchedulingVendorService } from './infrastructure/prisma-scheduling-vendor.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    PrismaSchedulingVendorService,
    { provide: SchedulingVendorService, useExisting: PrismaSchedulingVendorService },
  ],
  exports: [SchedulingVendorService],
})
export class SchedulingVendorModule {}
