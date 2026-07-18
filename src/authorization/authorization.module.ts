import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import {
  RequestContextStore,
  requestContextStore,
} from '../common/context/request-context.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AuthorizationPolicy } from './application/authorization.policy.js';
import {
  PrismaTenantAuthorizationExecutor,
  TenantAuthorizationExecutor,
} from './application/tenant-authorization.executor.js';
import { PrismaAuthorizationPolicy } from './infrastructure/prisma-authorization.policy.js';
import { PrismaSecurityDenialRecorder } from './infrastructure/security-denial.recorder.js';
import { ActorGuard } from './http/actor.guard.js';

@Module({
  imports: [AuditModule, DatabaseModule, IdentityModule],
  providers: [
    PrismaAuthorizationPolicy,
    { provide: RequestContextStore, useValue: requestContextStore },
    { provide: AuthorizationPolicy, useExisting: PrismaAuthorizationPolicy },
    PrismaSecurityDenialRecorder,
    PrismaTenantAuthorizationExecutor,
    ActorGuard,
    {
      provide: TenantAuthorizationExecutor,
      useExisting: PrismaTenantAuthorizationExecutor,
    },
  ],
  exports: [
    ActorGuard,
    AuthorizationPolicy,
    RequestContextStore,
    TenantAuthorizationExecutor,
  ],
})
export class AuthorizationModule {}
