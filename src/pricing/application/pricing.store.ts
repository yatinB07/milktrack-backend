import type { TransactionContext } from '../../common/application/transaction-context.js';

export type PriceRecord = Readonly<{ id: string; vendorId: string; productId: string; unitId: string; amountMinor: string; currency: string; effectiveFrom: Date; effectiveTo: Date | null; createdAt: Date; updatedAt: Date }>;
export type OverrideRecord = PriceRecord & Readonly<{ householdId: string; reason: string }>;
export type PricePageQuery = Readonly<{ cursor?: string; limit?: number; productId?: string; unitId?: string }>;
export type PricePage<T> = Readonly<{ items: readonly T[]; nextCursor?: string }>;
export type CreateGlobalPrice = Readonly<{ id: string; vendorId: string; productId: string; unitId: string; amountMinor: bigint; currency: string; effectiveFrom: Date; effectiveTo?: Date; createdBy: string }>;
export type CreateCustomerOverride = CreateGlobalPrice & Readonly<{ householdId: string; reason: string }>;

/** Pricing-owned persistence boundary; every operation joins the caller's tenant transaction. */
export abstract class PricingStore {
  abstract listGlobals(tx: TransactionContext, query: PricePageQuery): Promise<PricePage<PriceRecord>>;
  abstract listOverrides(tx: TransactionContext, householdId: string, query: PricePageQuery): Promise<PricePage<OverrideRecord>>;
  abstract getGlobal(tx: TransactionContext, id: string): Promise<PriceRecord>;
  abstract getOverride(tx: TransactionContext, householdId: string, id: string): Promise<OverrideRecord>;
  abstract createGlobal(tx: TransactionContext, input: CreateGlobalPrice): Promise<PriceRecord>;
  abstract createOverride(tx: TransactionContext, input: CreateCustomerOverride): Promise<OverrideRecord>;
  abstract closeGlobal(tx: TransactionContext, id: string, effectiveTo: Date): Promise<Readonly<{ before: PriceRecord; after: PriceRecord }>>;
  abstract closeOverride(tx: TransactionContext, householdId: string, id: string, effectiveTo: Date): Promise<Readonly<{ before: OverrideRecord; after: OverrideRecord }>>;
  abstract resolveOverride(tx: TransactionContext, householdId: string, productId: string, unitId: string, at: Date): Promise<OverrideRecord | undefined>;
  abstract resolveGlobal(tx: TransactionContext, productId: string, unitId: string, at: Date): Promise<PriceRecord | undefined>;
}
