import { Inject, Injectable } from '@nestjs/common';

import { CatalogService } from '../../catalog/application/catalog.service.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import { VendorService } from '../../vendors/application/vendor.service.js';
import { resolveServiceInstant } from '../domain/service-time.js';
import { PricingStore } from './pricing.store.js';

export type DeliveryPriceResolutionInput = Readonly<{
  householdId: string;
  productId: string;
  unitId: string;
  deliverySlotId: string;
  serviceDate: string;
}>;

export type DeliveryPriceEvidence = Readonly<{
  amountMinor: string;
  currency: string;
  pricingLevel: 'customer_specific' | 'global';
  sourcePriceId: string;
  sourcePriceType: 'customer_price_override' | 'global_price';
  resolvedAt: Date;
}>;

/** Resolves immutable price evidence at the delivery's original vendor-local service instant. */
export abstract class DeliveryPriceService {
  abstract resolve(
    tx: TransactionContext,
    vendorId: string,
    input: DeliveryPriceResolutionInput,
  ): Promise<DeliveryPriceEvidence | undefined>;
}

@Injectable()
export class DefaultDeliveryPriceService extends DeliveryPriceService {
  constructor(
    @Inject(PricingStore) private readonly prices: PricingStore,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(VendorService) private readonly vendors: VendorService,
  ) {
    super();
  }

  async resolve(
    tx: TransactionContext,
    vendorId: string,
    input: DeliveryPriceResolutionInput,
  ): Promise<DeliveryPriceEvidence | undefined> {
    const [settings, slotStart] = await Promise.all([
      this.vendors.getPricingSettings(tx, vendorId),
      this.catalog.getPricingDeliverySlotStart(tx, input.deliverySlotId),
    ]);
    const resolvedAt = resolveServiceInstant(settings.timezone, input.serviceDate, slotStart);
    const override = await this.prices.resolveOverride(
      tx,
      input.householdId,
      input.productId,
      input.unitId,
      resolvedAt,
    );
    const price = override ?? await this.prices.resolveGlobal(tx, input.productId, input.unitId, resolvedAt);
    if (!price) return undefined;
    return {
      amountMinor: price.amountMinor,
      currency: price.currency,
      pricingLevel: override ? 'customer_specific' : 'global',
      sourcePriceId: price.id,
      sourcePriceType: override ? 'customer_price_override' : 'global_price',
      resolvedAt,
    };
  }
}
