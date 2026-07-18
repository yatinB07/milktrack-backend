import { Module } from '@nestjs/common';

import {
  RequestContextStore,
  requestContextStore,
} from './common/context/request-context.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [DatabaseModule, HealthModule],
  providers: [{ provide: RequestContextStore, useValue: requestContextStore }],
})
export class AppModule {}
