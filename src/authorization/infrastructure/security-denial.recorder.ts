import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service.js';

export type SecurityDenial = Readonly<{
  actorUserId: string;
  vendorId: string;
  operation: string;
  reasonCode: string;
  correlationId: string;
}>;

@Injectable()
export class PrismaSecurityDenialRecorder {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Records outside the rolled-back tenant transaction without tenant context. */
  async record(denial: SecurityDenial): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.vendor_id', '', true)`;
      await tx.$executeRaw`
        INSERT INTO audit_events
          (id, actor_user_id, action, entity_type, entity_id, new_value,
           reason, correlation_id)
        VALUES
          (${randomUUID()}::uuid, ${denial.actorUserId}::uuid,
           'security.tenant_access_denied', 'vendor', ${denial.vendorId}::uuid,
           ${JSON.stringify({ operation: denial.operation })}::jsonb,
           ${denial.reasonCode}, ${denial.correlationId}::uuid)
      `;
    });
  }
}
