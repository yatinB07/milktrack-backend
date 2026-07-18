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
import { VendorController } from './http/vendor.controller.js';
import { PrismaVendorStore } from './infrastructure/prisma-vendor.store.js';

@Module({
  imports: [AuditModule, AuthorizationModule, DatabaseModule, IdentityModule],
  controllers: [VendorController],
  providers: [
    PrismaVendorStore,
    TransitionVendor,
    PrismaVendorService,
    { provide: VendorService, useExisting: PrismaVendorService },
  ],
  exports: [TransitionVendor, VendorService],
})
export class VendorsModule {}
