import type { TransactionContext } from '../../common/application/transaction-context.js';

export abstract class ScheduleDateLock {
  abstract lock(transaction: TransactionContext, vendorId: string, serviceDates: string[]): Promise<void>;
}
