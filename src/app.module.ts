import { Module } from '@nestjs/common';

import { AuditModule } from './audit/audit.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import {
  RequestContextStore,
  requestContextStore,
} from './common/context/request-context.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { VendorsModule } from './vendors/vendors.module.js';

@Module({
  imports: [
    AuditModule,
    AuthorizationModule,
    DatabaseModule,
    HealthModule,
    IdentityModule,
    VendorsModule,
  ],
  providers: [{ provide: RequestContextStore, useValue: requestContextStore }],
})
export class AppModule {}
