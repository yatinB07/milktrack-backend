import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { VendorsModule } from '../vendors/vendors.module.js';
import { DefaultLeaveService, LeaveService } from './application/leave.service.js';
import { LeaveStore } from './application/leave.store.js';
import { CustomerLeaveController } from './http/customer-leave.controller.js';
import { VendorLeaveController } from './http/vendor-leave.controller.js';
import { PrismaLeaveStore } from './infrastructure/prisma-leave.store.js';

@Module({
  imports: [AuditModule, AuthorizationModule, CustomersModule, DatabaseModule, IdentityModule, VendorsModule],
  controllers: [CustomerLeaveController, VendorLeaveController],
  providers: [PrismaLeaveStore, { provide: LeaveStore, useExisting: PrismaLeaveStore }, DefaultLeaveService, { provide: LeaveService, useExisting: DefaultLeaveService }],
  exports: [LeaveService, LeaveStore],
})
export class LeaveModule {}
