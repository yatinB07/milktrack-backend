import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { DefaultRouteService, RouteService } from './application/route.service.js';
import { RouteStore } from './application/route.store.js';
import { RouteController } from './http/route.controller.js';
import { PrismaRouteStore } from './infrastructure/prisma-route.store.js';

@Module({ imports: [AuditModule, AuthorizationModule, CatalogModule, DatabaseModule, IdentityModule], controllers: [RouteController], providers: [PrismaRouteStore, { provide: RouteStore, useExisting: PrismaRouteStore }, DefaultRouteService, { provide: RouteService, useExisting: DefaultRouteService }] })
export class RoutingModule {}
