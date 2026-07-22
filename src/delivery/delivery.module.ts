import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { LeaveModule } from '../leave/leave.module.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { VendorsModule } from '../vendors/vendors.module.js';
import { AgentStopOutcomeService, DefaultAgentStopOutcomeService } from './application/agent-stop-outcome.service.js';
import { DefaultDeliveryCorrectionService, DeliveryCorrectionService } from './application/delivery-correction.service.js';
import { DeliveryQueryService } from './application/delivery-query.service.js';
import { DeliveryFoundationModule } from './delivery-foundation.module.js';
import { CustomerDeliveryController } from './http/customer-delivery.controller.js';
import { AgentDeliveryController } from './http/agent-delivery.controller.js';
import { VendorDeliveryController } from './http/vendor-delivery.controller.js';

@Module({
  imports: [AuditModule, AuthorizationModule, CustomersModule, DeliveryFoundationModule, LeaveModule, MembershipsModule, NotificationsModule, PricingModule, VendorsModule],
  controllers: [VendorDeliveryController, CustomerDeliveryController, AgentDeliveryController],
  providers: [
    DeliveryQueryService,
    DefaultDeliveryCorrectionService,
    { provide: DeliveryCorrectionService, useExisting: DefaultDeliveryCorrectionService },
    DefaultAgentStopOutcomeService,
    { provide: AgentStopOutcomeService, useExisting: DefaultAgentStopOutcomeService },
  ],
})
export class DeliveryModule {}
