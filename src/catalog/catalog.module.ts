import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CatalogService, PrismaCatalogService } from './application/catalog.service.js';
import { ProductController } from './http/product.controller.js';
import { UnitController } from './http/unit.controller.js';
import { DeliverySlotController } from './http/delivery-slot.controller.js';
import { PrismaCatalogStore } from './infrastructure/prisma-catalog.store.js';

@Module({
  imports: [AuditModule, AuthorizationModule, DatabaseModule, IdentityModule],
  controllers: [UnitController, ProductController, DeliverySlotController],
  providers: [PrismaCatalogStore, PrismaCatalogService, { provide: CatalogService, useExisting: PrismaCatalogService }],
})
export class CatalogModule {}
