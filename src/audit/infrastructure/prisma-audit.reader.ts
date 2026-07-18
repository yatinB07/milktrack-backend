import { Injectable } from '@nestjs/common';

import type { CursorValue } from '../../common/cursor/cursor.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import type { AuditEventResult } from '../application/list-audit-events.js';

export type AuditReaderQuery = Readonly<{
  limit: number;
  cursor?: CursorValue;
  action?: string;
  entityType?: string;
  entityId?: string;
}>;

@Injectable()
export class PrismaAuditReader {
  async list(
    context: TransactionContext,
    vendorId: string,
    query: AuditReaderQuery,
  ): Promise<
    Readonly<{ items: readonly AuditEventResult[]; next?: CursorValue }>
  > {
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.auditEvent.findMany({
      where: {
        vendorId,
        ...(query.action === undefined ? {} : { action: query.action }),
        ...(query.entityType === undefined
          ? {}
          : { entityType: query.entityType }),
        ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
        ...(query.cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: query.cursor.createdAt } },
                {
                  createdAt: query.cursor.createdAt,
                  id: { lt: query.cursor.id },
                },
              ],
            }),
      },
      select: {
        id: true,
        vendorId: true,
        actorUserId: true,
        action: true,
        entityType: true,
        entityId: true,
        oldValue: true,
        newValue: true,
        reason: true,
        correlationId: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const items = rows.slice(0, query.limit).map((row) => {
      if (row.vendorId === null || row.actorUserId === null) {
        throw new ApplicationError(
          'INVALID_AUDIT_EVENT',
          'Tenant audit data is invalid',
          500,
        );
      }
      return {
        id: row.id,
        vendorId: row.vendorId,
        actorUserId: row.actorUserId,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        ...(row.oldValue === null ? {} : { oldValue: row.oldValue }),
        ...(row.newValue === null ? {} : { newValue: row.newValue }),
        ...(row.reason === null ? {} : { reason: row.reason }),
        correlationId: row.correlationId,
        createdAt: row.createdAt,
      };
    });
    const last = items.at(-1);
    return {
      items,
      ...(rows.length <= query.limit || last === undefined
        ? {}
        : { next: { createdAt: last.createdAt, id: last.id } }),
    };
  }
}
