import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { VendorsModule } from '../vendors/vendors.module.js';
import { DefaultSubscriptionService, SubscriptionService } from './application/subscription.service.js';
import { SubscriptionStore } from './application/subscription.store.js';
import { CustomerSubscriptionController, VendorSubscriptionController } from './http/subscription.controller.js';
import { PrismaSubscriptionStore } from './infrastructure/prisma-subscription.store.js';

@Module({
  imports: [AuditModule, AuthorizationModule, CatalogModule, CustomersModule, DatabaseModule, IdentityModule, VendorsModule],
  controllers: [VendorSubscriptionController, CustomerSubscriptionController],
  providers: [PrismaSubscriptionStore, { provide: SubscriptionStore, useExisting: PrismaSubscriptionStore }, DefaultSubscriptionService, { provide: SubscriptionService, useExisting: DefaultSubscriptionService }],
})
export class SubscriptionsModule {}
