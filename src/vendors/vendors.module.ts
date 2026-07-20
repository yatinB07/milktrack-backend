import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { TransitionVendor } from './application/transition-vendor.js';
import {
  PrismaVendorService,
  VendorService,
} from './application/vendor.service.js';
import { SchedulingVendorService } from './application/scheduling-vendor.service.js';
import { VendorController } from './http/vendor.controller.js';
import { VendorProfileController } from './http/vendor-profile.controller.js';
import { PrismaSchedulingVendorService } from './infrastructure/prisma-scheduling-vendor.service.js';
import { PrismaVendorStore } from './infrastructure/prisma-vendor.store.js';

@Module({
  imports: [AuditModule, AuthorizationModule, DatabaseModule, IdentityModule],
  controllers: [VendorController, VendorProfileController],
  providers: [
    PrismaVendorStore,
    TransitionVendor,
    PrismaVendorService,
    { provide: VendorService, useExisting: PrismaVendorService },
    PrismaSchedulingVendorService,
    { provide: SchedulingVendorService, useExisting: PrismaSchedulingVendorService },
  ],
  exports: [TransitionVendor, VendorService, SchedulingVendorService],
})
export class VendorsModule {}
