import type { TransactionContext } from '../../common/application/transaction-context.js';

export type SchedulableVendor = Readonly<{
  id: string;
  timezone: string;
}>;

export type SchedulableVendorPage = Readonly<{
  items: readonly SchedulableVendor[];
  nextCursor?: string;
}>;

export abstract class SchedulingVendorService {
  abstract listEligible(
    input: Readonly<{ cursor?: string; limit: number }>,
  ): Promise<SchedulableVendorPage>;

  abstract findEligible(
    transaction: TransactionContext,
    vendorId: string,
  ): Promise<SchedulableVendor | null>;
}
