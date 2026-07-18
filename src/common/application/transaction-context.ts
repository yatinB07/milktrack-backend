declare const transactionContextBrand: unique symbol;

/** Opaque handle for infrastructure participating in one physical transaction. */
export type TransactionContext = Readonly<{
  [transactionContextBrand]: true;
}>;

export abstract class TenantTransactionRunner {
  abstract run<T>(
    vendorId: string,
    operation: (context: TransactionContext) => Promise<T>,
  ): Promise<T>;
}
