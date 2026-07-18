import { Module } from '@nestjs/common';

import { AuditModule } from './audit/audit.module.js';
import {
  RequestContextStore,
  requestContextStore,
} from './common/context/request-context.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [AuditModule, DatabaseModule, HealthModule],
  providers: [{ provide: RequestContextStore, useValue: requestContextStore }],
})
export class AppModule {}
