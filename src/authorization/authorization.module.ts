import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import {
  RequestContextStore,
  requestContextStore,
} from '../common/context/request-context.js';
import { DatabaseModule } from '../database/database.module.js';
import {
  AuthenticationAuthorityPort,
  UserLifecycleAuthorizationPort,
} from './application/identity-authorization.port.js';
import { AuthorizationPolicy } from './application/authorization.policy.js';
import {
  PrismaTenantAuthorizationExecutor,
  TenantAuthorizationExecutor,
} from './application/tenant-authorization.executor.js';
import { PrismaAuthorizationPolicy } from './infrastructure/prisma-authorization.policy.js';
import { PrismaIdentityAuthorizationAdapter } from './infrastructure/prisma-identity-authorization.adapter.js';
import { PrismaSecurityDenialRecorder } from './infrastructure/security-denial.recorder.js';

@Module({
  imports: [AuditModule, DatabaseModule],
  providers: [
    PrismaAuthorizationPolicy,
    { provide: RequestContextStore, useValue: requestContextStore },
    { provide: AuthorizationPolicy, useExisting: PrismaAuthorizationPolicy },
    PrismaSecurityDenialRecorder,
    PrismaTenantAuthorizationExecutor,
    PrismaIdentityAuthorizationAdapter,
    {
      provide: AuthenticationAuthorityPort,
      useExisting: PrismaIdentityAuthorizationAdapter,
    },
    {
      provide: UserLifecycleAuthorizationPort,
      useExisting: PrismaIdentityAuthorizationAdapter,
    },
    {
      provide: TenantAuthorizationExecutor,
      useExisting: PrismaTenantAuthorizationExecutor,
    },
  ],
  exports: [
    AuthorizationPolicy,
    AuthenticationAuthorityPort,
    UserLifecycleAuthorizationPort,
    RequestContextStore,
    TenantAuthorizationExecutor,
  ],
})
export class AuthorizationModule {}
