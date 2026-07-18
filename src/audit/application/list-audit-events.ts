import { Inject, Injectable } from '@nestjs/common';

import {
  TenantAuthorizationExecutor,
} from '../../authorization/application/tenant-authorization.executor.js';
import type { Actor } from '../../common/context/request-context.js';
import { CursorCodec } from '../../common/cursor/cursor.js';
import { PrismaAuditReader } from '../infrastructure/prisma-audit.reader.js';

export type ListAuditEventsQuery = Readonly<{
  cursor?: string;
  limit?: number;
  action?: string;
  entityType?: string;
  entityId?: string;
}>;

export type AuditEventResult = Readonly<{
  id: string;
  vendorId: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string;
  correlationId: string;
  createdAt: Date;
}>;

export abstract class ListAuditEvents {
  abstract execute(
    actor: Actor,
    vendorId: string,
    query: ListAuditEventsQuery,
  ): Promise<
    Readonly<{ items: readonly AuditEventResult[]; nextCursor?: string }>
  >;
}

@Injectable()
export class PrismaListAuditEvents extends ListAuditEvents {
  private readonly cursors = new CursorCodec();

  constructor(
    @Inject(TenantAuthorizationExecutor)
    private readonly authorization: TenantAuthorizationExecutor,
    @Inject(PrismaAuditReader)
    private readonly audits: PrismaAuditReader,
  ) {
    super();
  }

  async execute(
    actor: Actor,
    vendorId: string,
    query: ListAuditEventsQuery,
  ): Promise<
    Readonly<{ items: readonly AuditEventResult[]; nextCursor?: string }>
  > {
    const limit = this.cursors.parseLimit(query.limit);
    const cursor =
      query.cursor === undefined ? undefined : this.cursors.decode(query.cursor);
    const page = await this.authorization.execute(
      {
        actor,
        vendorId,
        permission: 'audit:read',
        operation: 'audit.list',
      },
      (tx) =>
        this.audits.list(tx, vendorId, {
          limit,
          cursor,
          action: query.action,
          entityType: query.entityType,
          entityId: query.entityId,
        }),
    );
    return {
      items: page.items,
      ...(page.next === undefined
        ? {}
        : { nextCursor: this.cursors.encode(page.next) }),
    };
  }
}
