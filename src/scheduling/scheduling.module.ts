import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { scheduleWorkerOptionsFromEnvironment } from '../bootstrap/schedule-worker-environment.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { ScheduleCoordinationModule } from '../schedule-coordination/schedule-coordination.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { VendorsModule } from '../vendors/vendors.module.js';
import { DefaultScheduleRunProcessor } from './application/default-schedule-run-processor.js';
import { DefaultScheduleWorker } from './application/default-schedule-worker.js';
import { DefaultScheduleGenerationRunService, ScheduleGenerationRunService } from './application/schedule-generation-run.service.js';
import { ScheduleGenerationRunStore } from './application/schedule-generation-run.store.js';
import { DefaultScheduleGenerator, ScheduleGenerator } from './application/schedule-generator.js';
import { ScheduleRunProcessor } from './application/schedule-run-processor.js';
import { SCHEDULE_WORKER_OPTIONS, ScheduleWorker } from './application/schedule-worker.js';
import { ScheduledDeliveryStore } from './application/scheduled-delivery.store.js';
import { DefaultScheduledDeliveryService, ScheduledDeliveryService } from './application/scheduled-delivery.service.js';
import { ScheduleGenerationRunController } from './http/schedule-generation-run.controller.js';
import { AgentScheduledDeliveryController } from './http/scheduled-delivery.controller.js';
import { PrismaScheduleGenerationRunStore } from './infrastructure/prisma-schedule-generation-run.store.js';
import { PrismaScheduledDeliveryStore } from './infrastructure/prisma-scheduled-delivery.store.js';

@Module({
  imports: [
    AuditModule,
    AuthorizationModule,
    DatabaseModule,
    IdentityModule,
    MembershipsModule,
    PricingModule,
    RoutingModule,
    ScheduleCoordinationModule,
    SubscriptionsModule,
    VendorsModule,
  ],
  controllers: [AgentScheduledDeliveryController, ScheduleGenerationRunController],
  providers: [
    PrismaScheduledDeliveryStore,
    { provide: ScheduledDeliveryStore, useExisting: PrismaScheduledDeliveryStore },
    DefaultScheduleGenerator,
    { provide: ScheduleGenerator, useExisting: DefaultScheduleGenerator },
    DefaultScheduledDeliveryService,
    { provide: ScheduledDeliveryService, useExisting: DefaultScheduledDeliveryService },
    PrismaScheduleGenerationRunStore,
    { provide: ScheduleGenerationRunStore, useExisting: PrismaScheduleGenerationRunStore },
    DefaultScheduleRunProcessor,
    { provide: ScheduleRunProcessor, useExisting: DefaultScheduleRunProcessor },
    DefaultScheduleGenerationRunService,
    { provide: ScheduleGenerationRunService, useExisting: DefaultScheduleGenerationRunService },
    {
      provide: SCHEDULE_WORKER_OPTIONS,
      useFactory: () => scheduleWorkerOptionsFromEnvironment(process.env),
    },
    DefaultScheduleWorker,
    { provide: ScheduleWorker, useExisting: DefaultScheduleWorker },
  ],
  exports: [ScheduleGenerator, ScheduleWorker],
})
export class SchedulingModule {}
