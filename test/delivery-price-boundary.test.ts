import assert from 'node:assert/strict';
import test from 'node:test';

import type { CatalogService } from '../src/catalog/application/catalog.service.js';
import type { TransactionContext } from '../src/common/application/transaction-context.js';
import type { VendorService } from '../src/vendors/application/vendor.service.js';
import { DefaultDeliveryPriceService } from '../src/pricing/application/delivery-price.service.js';
import type { OverrideRecord, PriceRecord, PricingStore } from '../src/pricing/application/pricing.store.js';

const tx = {} as TransactionContext;
const input = {
  householdId: 'household', productId: 'product', unitId: 'unit', deliverySlotId: 'slot', serviceDate: '2030-01-01',
};
const globalPrice: PriceRecord = {
  id: 'global-price', vendorId: 'vendor', productId: 'product', unitId: 'unit', amountMinor: '100', currency: 'INR',
  effectiveFrom: new Date('2029-01-01T00:00:00Z'), effectiveTo: null, createdAt: new Date(), updatedAt: new Date(),
};
const overridePrice: OverrideRecord = { ...globalPrice, id: 'override-price', amountMinor: '95', householdId: 'household', reason: 'Agreement' };

function service(options: Readonly<{
  timezone?: string;
  slotStart?: string;
  override?: OverrideRecord;
  global?: PriceRecord;
  onResolve?: (kind: 'override' | 'global', at: Date) => void;
}> = {}) {
  const prices = {
    resolveOverride: (_tx: TransactionContext, _householdId: string, _productId: string, _unitId: string, at: Date) => {
      options.onResolve?.('override', at);
      return Promise.resolve(options.override);
    },
    resolveGlobal: (_tx: TransactionContext, _productId: string, _unitId: string, at: Date) => {
      options.onResolve?.('global', at);
      return Promise.resolve(options.global);
    },
  } as PricingStore;
  const catalog = { getPricingDeliverySlotStart: () => Promise.resolve(options.slotStart ?? '06:00') } as unknown as CatalogService;
  const vendors = { getPricingSettings: () => Promise.resolve({ timezone: options.timezone ?? 'Asia/Kolkata', currency: 'INR' }) } as unknown as VendorService;
  return new DefaultDeliveryPriceService(prices, catalog, vendors);
}

void test('delivery evidence preserves override identity and original service instant', async () => {
  const result = await service({ override: overridePrice }).resolve(tx, 'vendor', input);

  assert.deepEqual(result, {
    amountMinor: '95', currency: 'INR', pricingLevel: 'customer_specific',
    sourcePriceId: 'override-price', sourcePriceType: 'customer_price_override',
    resolvedAt: new Date('2030-01-01T00:30:00.000Z'),
  });
});

void test('delivery evidence falls back to the global price and preserves its identity', async () => {
  const result = await service({ global: globalPrice }).resolve(tx, 'vendor', input);

  assert.deepEqual(result, {
    amountMinor: '100', currency: 'INR', pricingLevel: 'global',
    sourcePriceId: 'global-price', sourcePriceType: 'global_price',
    resolvedAt: new Date('2030-01-01T00:30:00.000Z'),
  });
});

void test('delivery evidence is absent when neither price level applies', async () => {
  assert.equal(await service().resolve(tx, 'vendor', input), undefined);
});

void test('delivery evidence resolves the service date in vendor time across UTC rollover', async () => {
  const calls: Date[] = [];
  await service({ slotStart: '00:15', global: globalPrice, onResolve: (_kind, at) => calls.push(at) })
    .resolve(tx, 'vendor', { ...input, serviceDate: '2030-01-01' });

  assert.deepEqual(calls, [new Date('2029-12-31T18:45:00.000Z'), new Date('2029-12-31T18:45:00.000Z')]);
});

void test('delivery evidence passes the half-open boundary instant unchanged to price resolution', async () => {
  const calls: Date[] = [];
  await service({ global: globalPrice, onResolve: (_kind, at) => calls.push(at) })
    .resolve(tx, 'vendor', { ...input, serviceDate: '2026-07-20' });

  assert.deepEqual(calls, [new Date('2026-07-20T00:30:00.000Z'), new Date('2026-07-20T00:30:00.000Z')]);
});

void test('delivery evidence rejects a nonexistent DST service instant before price lookup', async () => {
  await assert.rejects(
    service({ timezone: 'America/New_York', slotStart: '02:30' }).resolve(tx, 'vendor', { ...input, serviceDate: '2026-03-08' }),
    (cause: unknown) => Boolean(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'INVALID_SERVICE_TIME'),
  );
});

void test('delivery evidence chooses the earliest UTC instant during a DST overlap', async () => {
  const calls: Date[] = [];
  await service({ timezone: 'America/New_York', slotStart: '01:30', global: globalPrice, onResolve: (_kind, at) => calls.push(at) })
    .resolve(tx, 'vendor', { ...input, serviceDate: '2026-11-01' });

  assert.deepEqual(calls, [new Date('2026-11-01T05:30:00.000Z'), new Date('2026-11-01T05:30:00.000Z')]);
});
