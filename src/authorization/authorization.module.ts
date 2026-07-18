import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { requestContextStore } from '../common/context/request-context.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuthenticationService } from '../identity/application/authentication.service.js';
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
    { provide: AuthorizationPolicy, useExisting: PrismaAuthorizationPolicy },
    PrismaSecurityDenialRecorder,
    PrismaTenantAuthorizationExecutor,
    {
      provide: ActorGuard,
      inject: [AuthenticationService],
      useFactory: (authentication: AuthenticationService) =>
        new ActorGuard(authentication, requestContextStore),
    },
    {
      provide: TenantAuthorizationExecutor,
      useExisting: PrismaTenantAuthorizationExecutor,
    },
  ],
  exports: [ActorGuard, AuthorizationPolicy, TenantAuthorizationExecutor],
})
export class AuthorizationModule {}
