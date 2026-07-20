import type { TransactionContext } from '../../common/application/transaction-context.js';

export abstract class ScheduleRegenerationWriter {
  abstract write(
    transaction: TransactionContext,
    vendorId: string,
    triggerLocalDate: string,
    serviceDates: readonly string[],
    requestedByUserId: string,
  ): Promise<void>;
}
