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
import { SubscriptionLabelsModule } from '../subscriptions/subscription-labels.module.js';
import { VendorsModule } from '../vendors/vendors.module.js';
import { DefaultLeaveService, LeaveService } from './application/leave.service.js';
import { DefaultEffectiveLeaveService, EffectiveLeaveService } from './application/effective-leave.service.js';
import { CustomerLeaveController } from './http/customer-leave.controller.js';
import { VendorLeaveController } from './http/vendor-leave.controller.js';
import { LeaveSchedulingModule } from './leave-scheduling.module.js';

@Module({
  imports: [AuditModule, AuthorizationModule, CustomersModule, DatabaseModule, DeliveryFoundationModule, IdentityModule, LeaveSchedulingModule, MembershipsModule, NotificationsModule, RoutingModule, SubscriptionLabelsModule, VendorsModule],
  controllers: [CustomerLeaveController, VendorLeaveController],
  providers: [
    DefaultLeaveService,
    { provide: LeaveService, useExisting: DefaultLeaveService },
    DefaultEffectiveLeaveService,
    { provide: EffectiveLeaveService, useExisting: DefaultEffectiveLeaveService },
  ],
  exports: [LeaveService, LeaveSchedulingModule, EffectiveLeaveService],
})
export class LeaveModule {}
