import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { LeaveModule } from '../leave/leave.module.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { ScheduleCoordinationModule } from '../schedule-coordination/schedule-coordination.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { VendorsModule } from '../vendors/vendors.module.js';
import { DefaultScheduleGenerationRunService, ScheduleGenerationRunService } from './application/schedule-generation-run.service.js';
import { DefaultScheduledDeliveryService, ScheduledDeliveryService } from './application/scheduled-delivery.service.js';
import { ScheduleGenerationRunController } from './http/schedule-generation-run.controller.js';
import { AgentScheduledDeliveryController } from './http/scheduled-delivery.controller.js';
import { ScheduleGenerationModule } from './schedule-generation.module.js';

@Module({
  imports: [
    AuditModule,
    AuthorizationModule,
    DatabaseModule,
    IdentityModule,
    LeaveModule,
    MembershipsModule,
    PricingModule,
    RoutingModule,
    ScheduleCoordinationModule,
    SubscriptionsModule,
    VendorsModule,
    ScheduleGenerationModule,
  ],
  controllers: [AgentScheduledDeliveryController, ScheduleGenerationRunController],
  providers: [
    DefaultScheduledDeliveryService,
    { provide: ScheduledDeliveryService, useExisting: DefaultScheduledDeliveryService },
    DefaultScheduleGenerationRunService,
    { provide: ScheduleGenerationRunService, useExisting: DefaultScheduleGenerationRunService },
  ],
  exports: [ScheduleGenerationModule],
})
export class SchedulingModule {}
