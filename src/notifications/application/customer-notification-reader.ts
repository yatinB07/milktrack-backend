import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { NotificationType } from './notification-writer.js';

export type NotificationRecord = Readonly<{
  id: string;
  type: NotificationType;
  payload: Readonly<Record<string, string>>;
  readAt: Date | null;
  createdAt: Date;
}>;

export type NotificationPage = Readonly<{
  items: readonly NotificationRecord[];
  nextCursor?: string;
}>;

export abstract class CustomerNotificationReader {
  abstract list(
    tx: TransactionContext,
    input: Readonly<{
      vendorId: string;
      householdId: string;
      recipientUserId: string;
      cursor?: string;
      limit?: number;
    }>,
  ): Promise<NotificationPage>;
}
