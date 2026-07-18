import type { Prisma } from '../../generated/prisma/client.js';

export type AppendAuditEvent = Readonly<{
  id: string;
  vendorId?: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string;
  correlationId: string;
  ipHash?: string;
  deviceId?: string;
}>;

export abstract class AuditWriter {
  /** Appends through the caller's transaction so the audit and business write are atomic. */
  abstract append(
    tx: Prisma.TransactionClient,
    event: AppendAuditEvent,
  ): Promise<void>;
}
