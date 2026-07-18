import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuthorizationPolicy } from './application/authorization.policy.js';
import {
  PrismaTenantAuthorizationExecutor,
  TenantAuthorizationExecutor,
} from './application/tenant-authorization.executor.js';
import { PrismaAuthorizationPolicy } from './infrastructure/prisma-authorization.policy.js';
import { PrismaSecurityDenialRecorder } from './infrastructure/security-denial.recorder.js';

@Module({
  imports: [AuditModule, DatabaseModule],
  providers: [
    PrismaAuthorizationPolicy,
    { provide: AuthorizationPolicy, useExisting: PrismaAuthorizationPolicy },
    PrismaSecurityDenialRecorder,
    PrismaTenantAuthorizationExecutor,
    {
      provide: TenantAuthorizationExecutor,
      useExisting: PrismaTenantAuthorizationExecutor,
    },
  ],
  exports: [AuthorizationPolicy, TenantAuthorizationExecutor],
})
export class AuthorizationModule {}
