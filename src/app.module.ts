import { Module } from '@nestjs/common';

import { AuditReadModule } from './audit/audit-read.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import {
  RequestContextStore,
  requestContextStore,
} from './common/context/request-context.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { MembershipsModule } from './memberships/memberships.module.js';
import { VendorsModule } from './vendors/vendors.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { PricingModule } from './pricing/pricing.module.js';
import { SubscriptionsModule } from './subscriptions/subscriptions.module.js';
import { RoutingModule } from './routing/routing.module.js';

@Module({
  imports: [
    AuditReadModule,
    AuthorizationModule,
    DatabaseModule,
    HealthModule,
    IdentityModule,
    MembershipsModule,
    VendorsModule,
    CustomersModule,
    CatalogModule,
    PricingModule,
    SubscriptionsModule,
    RoutingModule,
  ],
  providers: [{ provide: RequestContextStore, useValue: requestContextStore }],
})
export class AppModule {}
