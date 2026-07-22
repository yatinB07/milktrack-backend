import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

import { CursorCodec } from '../../common/cursor/cursor.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { PageQuery } from '../../customers/application/household.service.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { NotificationWriter, type AppendNotification, type NotificationType } from '../application/notification-writer.js';

export type NotificationRecord = Readonly<{
  id: string;
  type: NotificationType;
  payload: Readonly<Record<string, string>>;
  readAt: Date | null;
  createdAt: Date;
}>;
export type NotificationPage = Readonly<{ items: readonly NotificationRecord[]; nextCursor?: string }>;

const allowedPayloadKeys: Readonly<Record<NotificationType, readonly string[]>> = {
  leave_accepted: ['leaveRequestId'],
  leave_rejected: ['leaveRequestId'],
  agent_reported_skip: ['scheduledDeliveryId'],
  delivery_corrected: ['scheduledDeliveryId'],
};
const prohibitedPayloadKey = /password|otp|token|secret|phone|address|latitude|longitude|note/i;

@Injectable()
export class PrismaNotificationStore extends NotificationWriter {
  private readonly cursors = new CursorCodec();

  async append(tx: TransactionContext, notification: AppendNotification): Promise<void> {
    this.validatePayload(notification);
    await unwrapPrismaTransaction(tx).notification.create({
      data: { ...notification, type: this.databaseType(notification.type), payload: notification.payload as Prisma.InputJsonValue },
    });
  }

  async list(tx: TransactionContext, vendorId: string, recipientUserId: string, query: PageQuery): Promise<NotificationPage> {
    const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor === undefined ? undefined : this.cursors.decode(query.cursor);
    const rows = await unwrapPrismaTransaction(tx).notification.findMany({
      where: {
        vendorId, recipientUserId,
        ...(cursor === undefined ? {} : { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
    });
    const items = rows.slice(0, limit).map((row) => this.record(row));
    const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { nextCursor: this.cursors.encode(last) } : {}) };
  }

  private validatePayload(notification: AppendNotification) {
    const allowed = allowedPayloadKeys[notification.type];
    for (const [key, value] of Object.entries(notification.payload)) {
      if (prohibitedPayloadKey.test(key) || !allowed.includes(key) || typeof value !== 'string')
        throw new ApplicationError('INVALID_NOTIFICATION_PAYLOAD', 'Notification payload is invalid', 400);
    }
  }

  private databaseType(type: NotificationType) { return type === 'agent_reported_skip' ? 'agent_skip' : type; }
  private record(row: Readonly<{ id: string; type: string; payload: Prisma.JsonValue; readAt: Date | null; createdAt: Date }>): NotificationRecord {
    const type = row.type === 'agent_skip' ? 'agent_reported_skip' : row.type;
    if (!['leave_accepted', 'leave_rejected', 'agent_reported_skip', 'delivery_corrected'].includes(type) || !this.isPayload(row.payload))
      throw new ApplicationError('INVALID_NOTIFICATION_PAYLOAD', 'Notification payload is invalid', 500);
    const payload = row.payload;
    this.validatePayload({ id: row.id, vendorId: '', recipientUserId: '', type: type as NotificationType, payload });
    return { id: row.id, type: type as NotificationType, payload, readAt: row.readAt, createdAt: row.createdAt };
  }
  private isPayload(value: Prisma.JsonValue): value is Record<string, string> { return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string'); }
}
