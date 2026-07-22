import type { TransactionContext } from '../../common/application/transaction-context.js';

export type LeaveSubscriptionLabel = Readonly<{
  subscriptionId: string;
  productId: string;
  productName: string;
  deliverySlotId: string;
  deliverySlotName: string;
}>;

export type SubscriptionLabelReference =
  | Readonly<{ kind: 'range'; referenceId: string; subscriptionId: string; startDate: string; endDate: string }>
  | Readonly<{ kind: 'occurrence'; referenceId: string; subscriptionId: string; serviceDate: string; deliverySlotId: string }>;

export type SubscriptionLabelMatch = LeaveSubscriptionLabel & Readonly<{ referenceId: string }>;

export abstract class SubscriptionLabelReader {
  abstract read(
    tx: TransactionContext,
    input: Readonly<{
      vendorId: string;
      householdId?: string;
      references: readonly SubscriptionLabelReference[];
    }>,
  ): Promise<readonly SubscriptionLabelMatch[]>;
}
