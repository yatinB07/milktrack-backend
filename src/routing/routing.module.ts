import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { VendorsModule } from '../vendors/vendors.module.js';
import { ScheduleCoordinationModule } from '../schedule-coordination/schedule-coordination.module.js';
import { RouteAssignmentStore } from './application/route-assignment.store.js';
import { RouteStopPlanStore } from './application/route-stop-plan.store.js';
import { DefaultRoutingScheduleService, RoutingScheduleService } from './application/routing-schedule.service.js';
import { DefaultRouteService, RouteService } from './application/route.service.js';
import { RouteStore } from './application/route.store.js';
import { AgentRouteAssignmentController, RouteController } from './http/route.controller.js';
import { PrismaRouteAssignmentStore } from './infrastructure/prisma-route-assignment.store.js';
import { PrismaRouteStore } from './infrastructure/prisma-route.store.js';
import { PrismaRouteStopPlanStore } from './infrastructure/prisma-route-stop-plan.store.js';

@Module({
  imports: [
    AuditModule,
    AuthorizationModule,
    CatalogModule,
    CustomersModule,
    DatabaseModule,
    IdentityModule,
    MembershipsModule,
    VendorsModule,
    ScheduleCoordinationModule,
  ],
  controllers: [RouteController, AgentRouteAssignmentController],
  providers: [
    PrismaRouteStore,
    PrismaRouteStopPlanStore,
    PrismaRouteAssignmentStore,
    { provide: RouteStore, useExisting: PrismaRouteStore },
    { provide: RouteStopPlanStore, useExisting: PrismaRouteStopPlanStore },
    { provide: RouteAssignmentStore, useExisting: PrismaRouteAssignmentStore },
    DefaultRouteService,
    { provide: RouteService, useExisting: DefaultRouteService },
    DefaultRoutingScheduleService,
    { provide: RoutingScheduleService, useExisting: DefaultRoutingScheduleService },
  ],
  exports: [RoutingScheduleService],
})
export class RoutingModule {}
