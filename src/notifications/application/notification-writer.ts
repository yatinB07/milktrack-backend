import type { TransactionContext } from '../../common/application/transaction-context.js';

export const notificationTypes = ['leave_accepted', 'leave_rejected', 'agent_reported_skip', 'delivery_corrected'] as const;
export type NotificationType = typeof notificationTypes[number];
export type AppendNotification = Readonly<{
  id: string;
  vendorId: string;
  recipientUserId: string;
  type: NotificationType;
  payload: Readonly<Record<string, string>>;
}>;

/** Appends a presentation record to the caller's authoritative transaction. */
export abstract class NotificationWriter {
  abstract append(tx: TransactionContext, notification: AppendNotification): Promise<void>;
}
