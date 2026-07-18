import { Module } from '@nestjs/common';

import { AuditWriter } from './application/audit-writer.js';
import { PrismaAuditWriter } from './infrastructure/prisma-audit.writer.js';

@Module({
  providers: [
    PrismaAuditWriter,
    { provide: AuditWriter, useExisting: PrismaAuditWriter },
  ],
  exports: [AuditWriter],
})
export class AuditModule {}
