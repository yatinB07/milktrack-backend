import type { TransactionContext } from '../../common/application/transaction-context.js';

export const notificationTypes = ['leave_accepted', 'leave_rejected', 'agent_reported_skip', 'delivery_corrected'] as const;
export type NotificationType = typeof notificationTypes[number];
type NotificationSubject =
  | Readonly<{ type: 'leave_accepted' | 'leave_rejected'; payload: Readonly<{ leaveRequestId: string }> }>
  | Readonly<{ type: 'agent_reported_skip' | 'delivery_corrected'; payload: Readonly<{ scheduledDeliveryId: string }> }>;
export type AppendNotification = Readonly<{
  id: string;
  vendorId: string;
  householdId: string;
  recipientUserId: string;
}> & NotificationSubject;

/** Appends a presentation record to the caller's authoritative transaction. */
export abstract class NotificationWriter {
  abstract append(tx: TransactionContext, notification: AppendNotification): Promise<void>;
}
