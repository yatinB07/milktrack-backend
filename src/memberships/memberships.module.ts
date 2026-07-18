import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import {
  MembershipService,
  PrismaMembershipService,
} from './application/membership.service.js';
import { PrismaMembershipStore } from './infrastructure/prisma-membership.store.js';
import {
  MembershipController,
  UserLifecycleController,
} from './http/membership.controller.js';

@Module({
  imports: [AuditModule, AuthorizationModule, DatabaseModule, IdentityModule],
  controllers: [MembershipController, UserLifecycleController],
  providers: [
    PrismaMembershipStore,
    PrismaMembershipService,
    { provide: MembershipService, useExisting: PrismaMembershipService },
  ],
})
export class MembershipsModule {}
