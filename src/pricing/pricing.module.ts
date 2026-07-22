import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { VendorsModule } from '../vendors/vendors.module.js';
import { DefaultPricingService, PricingService } from './application/pricing.service.js';
import { DefaultDeliveryPriceService, DeliveryPriceService } from './application/delivery-price.service.js';
import { PricingStore } from './application/pricing.store.js';
import { GlobalPriceController } from './http/global-price.controller.js';
import { PriceOverrideController } from './http/price-override.controller.js';
import { CustomerResolvedPriceController, VendorResolvedPriceController } from './http/resolved-price.controller.js';
import { PrismaPricingStore } from './infrastructure/prisma-pricing.store.js';
import { DefaultSchedulingPriceService, SchedulingPriceService } from './application/scheduling-price.service.js';

@Module({
  imports: [AuditModule, AuthorizationModule, CatalogModule, CustomersModule, DatabaseModule, IdentityModule, VendorsModule],
  controllers: [GlobalPriceController, PriceOverrideController, VendorResolvedPriceController, CustomerResolvedPriceController],
  providers: [PrismaPricingStore, { provide: PricingStore, useExisting: PrismaPricingStore }, DefaultPricingService, { provide: PricingService, useExisting: DefaultPricingService }, DefaultSchedulingPriceService, { provide: SchedulingPriceService, useExisting: DefaultSchedulingPriceService }, DefaultDeliveryPriceService, { provide: DeliveryPriceService, useExisting: DefaultDeliveryPriceService }],
  exports: [DeliveryPriceService, SchedulingPriceService],
})
export class PricingModule {}
