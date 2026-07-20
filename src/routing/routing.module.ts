import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { VendorsModule } from '../vendors/vendors.module.js';
import { RouteStopPlanStore } from './application/route-stop-plan.store.js';
import { DefaultRouteService, RouteService } from './application/route.service.js';
import { RouteStore } from './application/route.store.js';
import { RouteController } from './http/route.controller.js';
import { PrismaRouteStore } from './infrastructure/prisma-route.store.js';
import { PrismaRouteStopPlanStore } from './infrastructure/prisma-route-stop-plan.store.js';

@Module({ imports: [AuditModule, AuthorizationModule, CatalogModule, CustomersModule, DatabaseModule, IdentityModule, VendorsModule], controllers: [RouteController], providers: [PrismaRouteStore, PrismaRouteStopPlanStore, { provide: RouteStore, useExisting: PrismaRouteStore }, { provide: RouteStopPlanStore, useExisting: PrismaRouteStopPlanStore }, DefaultRouteService, { provide: RouteService, useExisting: DefaultRouteService }] })
export class RoutingModule {}
