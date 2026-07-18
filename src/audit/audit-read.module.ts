import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import {
  ListAuditEvents,
  PrismaListAuditEvents,
} from './application/list-audit-events.js';
import { AuditModule } from './audit.module.js';
import { AuditController } from './http/audit.controller.js';
import { PrismaAuditReader } from './infrastructure/prisma-audit.reader.js';

@Module({
  imports: [AuditModule, AuthorizationModule, IdentityModule],
  controllers: [AuditController],
  providers: [
    PrismaAuditReader,
    PrismaListAuditEvents,
    { provide: ListAuditEvents, useExisting: PrismaListAuditEvents },
  ],
})
export class AuditReadModule {}
