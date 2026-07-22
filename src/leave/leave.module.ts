import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DeliveryFoundationModule } from '../delivery/delivery-foundation.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { VendorsModule } from '../vendors/vendors.module.js';
import { DefaultLeaveService, LeaveService } from './application/leave.service.js';
import { LeaveStore } from './application/leave.store.js';
import { DefaultSchedulingLeaveService, SchedulingLeaveService } from './application/scheduling-leave.service.js';
import { CustomerLeaveController } from './http/customer-leave.controller.js';
import { VendorLeaveController } from './http/vendor-leave.controller.js';
import { PrismaLeaveStore } from './infrastructure/prisma-leave.store.js';

@Module({
  imports: [AuditModule, AuthorizationModule, CustomersModule, DatabaseModule, DeliveryFoundationModule, IdentityModule, MembershipsModule, NotificationsModule, RoutingModule, VendorsModule],
  controllers: [CustomerLeaveController, VendorLeaveController],
  providers: [PrismaLeaveStore, { provide: LeaveStore, useExisting: PrismaLeaveStore }, DefaultLeaveService, { provide: LeaveService, useExisting: DefaultLeaveService }, DefaultSchedulingLeaveService, { provide: SchedulingLeaveService, useExisting: DefaultSchedulingLeaveService }],
  exports: [LeaveService, LeaveStore, SchedulingLeaveService],
})
export class LeaveModule {}
