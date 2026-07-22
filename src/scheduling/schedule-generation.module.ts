import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { LeaveStore } from '../leave/application/leave.store.js';
import { DefaultSchedulingLeaveService, SchedulingLeaveService } from '../leave/application/scheduling-leave.service.js';
import { PrismaLeaveStore } from '../leave/infrastructure/prisma-leave.store.js';
import { PricingStore } from '../pricing/application/pricing.store.js';
import { DefaultSchedulingPriceService, SchedulingPriceService } from '../pricing/application/scheduling-price.service.js';
import { PrismaPricingStore } from '../pricing/infrastructure/prisma-pricing.store.js';
import { RouteAssignmentStore } from '../routing/application/route-assignment.store.js';
import { DefaultRoutingScheduleService, RoutingScheduleService } from '../routing/application/routing-schedule.service.js';
import { PrismaRouteAssignmentStore } from '../routing/infrastructure/prisma-route-assignment.store.js';
import { ScheduleCoordinationModule } from '../schedule-coordination/schedule-coordination.module.js';
import { DefaultSubscriptionScheduleService, SubscriptionScheduleService } from '../subscriptions/application/subscription-schedule.service.js';
import { SubscriptionStore } from '../subscriptions/application/subscription.store.js';
import { PrismaSubscriptionStore } from '../subscriptions/infrastructure/prisma-subscription.store.js';
import { DefaultScheduleRunProcessor } from './application/default-schedule-run-processor.js';
import { ScheduleGenerationRunStore } from './application/schedule-generation-run.store.js';
import { DefaultScheduleGenerator, ScheduleGenerator } from './application/schedule-generator.js';
import { ScheduleRunProcessor } from './application/schedule-run-processor.js';
import { ScheduledDeliveryStore } from './application/scheduled-delivery.store.js';
import { PrismaScheduleGenerationRunStore } from './infrastructure/prisma-schedule-generation-run.store.js';
import { PrismaScheduledDeliveryStore } from './infrastructure/prisma-scheduled-delivery.store.js';

@Module({
  imports: [AuditModule, DatabaseModule, ScheduleCoordinationModule],
  providers: [
    PrismaLeaveStore,
    { provide: LeaveStore, useExisting: PrismaLeaveStore },
    DefaultSchedulingLeaveService,
    { provide: SchedulingLeaveService, useExisting: DefaultSchedulingLeaveService },
    PrismaPricingStore,
    { provide: PricingStore, useExisting: PrismaPricingStore },
    DefaultSchedulingPriceService,
    { provide: SchedulingPriceService, useExisting: DefaultSchedulingPriceService },
    PrismaSubscriptionStore,
    { provide: SubscriptionStore, useExisting: PrismaSubscriptionStore },
    DefaultSubscriptionScheduleService,
    { provide: SubscriptionScheduleService, useExisting: DefaultSubscriptionScheduleService },
    PrismaRouteAssignmentStore,
    { provide: RouteAssignmentStore, useExisting: PrismaRouteAssignmentStore },
    DefaultRoutingScheduleService,
    { provide: RoutingScheduleService, useExisting: DefaultRoutingScheduleService },
    PrismaScheduledDeliveryStore,
    { provide: ScheduledDeliveryStore, useExisting: PrismaScheduledDeliveryStore },
    DefaultScheduleGenerator,
    { provide: ScheduleGenerator, useExisting: DefaultScheduleGenerator },
    PrismaScheduleGenerationRunStore,
    { provide: ScheduleGenerationRunStore, useExisting: PrismaScheduleGenerationRunStore },
    DefaultScheduleRunProcessor,
    { provide: ScheduleRunProcessor, useExisting: DefaultScheduleRunProcessor },
  ],
  exports: [ScheduledDeliveryStore, ScheduleGenerator, ScheduleGenerationRunStore, ScheduleRunProcessor],
})
export class ScheduleGenerationModule {}
