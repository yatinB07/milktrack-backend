import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { ScheduleCoordinationModule } from '../schedule-coordination/schedule-coordination.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { DefaultScheduleGenerator, ScheduleGenerator } from './application/schedule-generator.js';
import { ScheduledDeliveryStore } from './application/scheduled-delivery.store.js';
import { DefaultScheduledDeliveryService, ScheduledDeliveryService } from './application/scheduled-delivery.service.js';
import { AgentScheduledDeliveryController } from './http/scheduled-delivery.controller.js';
import { PrismaScheduledDeliveryStore } from './infrastructure/prisma-scheduled-delivery.store.js';

@Module({
  imports: [
    AuthorizationModule,
    DatabaseModule,
    IdentityModule,
    MembershipsModule,
    PricingModule,
    RoutingModule,
    ScheduleCoordinationModule,
    SubscriptionsModule,
  ],
  controllers: [AgentScheduledDeliveryController],
  providers: [
    PrismaScheduledDeliveryStore,
    { provide: ScheduledDeliveryStore, useExisting: PrismaScheduledDeliveryStore },
    DefaultScheduleGenerator,
    { provide: ScheduleGenerator, useExisting: DefaultScheduleGenerator },
    DefaultScheduledDeliveryService,
    { provide: ScheduledDeliveryService, useExisting: DefaultScheduledDeliveryService },
  ],
  exports: [ScheduleGenerator],
})
export class SchedulingModule {}
