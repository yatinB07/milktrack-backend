import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import { CatalogService } from '../../catalog/application/catalog.service.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { Actor } from '../../common/context/request-context.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { HouseholdService } from '../../customers/application/household.service.js';
import { VendorService } from '../../vendors/application/vendor.service.js';
import { parseAmountMinor, parseEffectivePeriod } from '../domain/price-rules.js';
import { resolveServiceInstant } from '../domain/service-time.js';
import { PricingStore, type OverrideRecord, type PricePage, type PricePageQuery, type PriceRecord } from './pricing.store.js';

export type CreatePriceCommand = Readonly<{ productId: string; unitId: string; amountMinor: string; effectiveFrom: string; effectiveTo?: string }>;
export type CreateOverrideCommand = CreatePriceCommand & Readonly<{ reason: string }>;
export type ClosePriceCommand = Readonly<{ effectiveTo: string; reason: string }>;
export type ResolvePriceCommand = Readonly<{ householdId: string; productId: string; unitId: string; deliverySlotId: string; serviceDate: string }>;
type MissingPrice = Readonly<{ status: 'missing' }>;
type ResolvedValue = Readonly<{ status: 'resolved'; amountMinor: string; currency: string; source: 'customer_specific' | 'global' }>;
export type VendorResolvedPrice = MissingPrice | (ResolvedValue & Readonly<{ sourcePriceId: string }>);
export type CustomerResolvedPrice = (MissingPrice | ResolvedValue) & Readonly<{ serviceDate: string }>;

export abstract class PricingService {
  abstract listGlobals(actor: Actor, vendorId: string, query: PricePageQuery): Promise<PricePage<PriceRecord>>;
  abstract getGlobal(actor: Actor, vendorId: string, id: string): Promise<PriceRecord>;
  abstract createGlobal(actor: Actor, vendorId: string, command: CreatePriceCommand): Promise<PriceRecord>;
  abstract closeGlobal(actor: Actor, vendorId: string, id: string, command: ClosePriceCommand): Promise<PriceRecord>;
  abstract listOverrides(actor: Actor, vendorId: string, householdId: string, query: PricePageQuery): Promise<PricePage<OverrideRecord>>;
  abstract getOverride(actor: Actor, vendorId: string, householdId: string, id: string): Promise<OverrideRecord>;
  abstract createOverride(actor: Actor, vendorId: string, householdId: string, command: CreateOverrideCommand): Promise<OverrideRecord>;
  abstract closeOverride(actor: Actor, vendorId: string, householdId: string, id: string, command: ClosePriceCommand): Promise<OverrideRecord>;
  abstract resolveVendor(actor: Actor, vendorId: string, command: ResolvePriceCommand): Promise<VendorResolvedPrice>;
  abstract resolveCustomer(actor: Actor, vendorId: string, householdId: string, command: Omit<ResolvePriceCommand, 'householdId'>): Promise<CustomerResolvedPrice>;
}

@Injectable()
export class DefaultPricingService extends PricingService {
  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(PricingStore) private readonly prices: PricingStore,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(VendorService) private readonly vendors: VendorService,
    @Inject(AuditWriter) private readonly audits: AuditWriter,
  ) { super(); }

  listGlobals(actor: Actor, vendorId: string, query: PricePageQuery) { return this.execute(actor, vendorId, 'pricing:read', 'pricing.global-list', (tx) => this.prices.listGlobals(tx, query)); }
  getGlobal(actor: Actor, vendorId: string, id: string) { return this.execute(actor, vendorId, 'pricing:read', 'pricing.global-get', (tx) => this.prices.getGlobal(tx, id)); }
  createGlobal(actor: Actor, vendorId: string, command: CreatePriceCommand) {
    const amountMinor = parseAmountMinor(command.amountMinor); const period = parseEffectivePeriod(command.effectiveFrom, command.effectiveTo);
    return this.execute(actor, vendorId, 'pricing:manage', 'pricing.global-create', async (tx) => {
      await this.catalog.requirePricingProduct(tx, command.productId, command.unitId);
      const settings = await this.vendors.getPricingSettings(tx, vendorId);
      const price = await this.prices.createGlobal(tx, { id: randomUUID(), vendorId, productId: command.productId, unitId: command.unitId, amountMinor, currency: settings.currency, ...period, createdBy: actor.userId });
      await this.audit(tx, actor, vendorId, price.id, 'global_price.created', 'global_price', undefined, price);
      return price;
    });
  }
  closeGlobal(actor: Actor, vendorId: string, id: string, command: ClosePriceCommand) {
    const effectiveTo = this.closeInstant(command.effectiveTo); const reason = this.reason(command.reason);
    return this.execute(actor, vendorId, 'pricing:manage', 'pricing.global-close', async (tx) => {
      const change = await this.prices.closeGlobal(tx, id, effectiveTo);
      await this.audit(tx, actor, vendorId, id, 'global_price.closed', 'global_price', change.before, change.after, reason);
      return change.after;
    });
  }
  listOverrides(actor: Actor, vendorId: string, householdId: string, query: PricePageQuery) {
    return this.execute(actor, vendorId, 'pricing:read', 'pricing.override-list', async (tx) => { await this.households.requirePricingHousehold(tx, householdId); return this.prices.listOverrides(tx, householdId, query); });
  }
  getOverride(actor: Actor, vendorId: string, householdId: string, id: string) {
    return this.execute(actor, vendorId, 'pricing:read', 'pricing.override-get', async (tx) => { await this.households.requirePricingHousehold(tx, householdId); return this.prices.getOverride(tx, householdId, id); });
  }
  createOverride(actor: Actor, vendorId: string, householdId: string, command: CreateOverrideCommand) {
    const amountMinor = parseAmountMinor(command.amountMinor); const period = parseEffectivePeriod(command.effectiveFrom, command.effectiveTo); const reason = this.reason(command.reason);
    return this.execute(actor, vendorId, 'pricing:manage', 'pricing.override-create', async (tx) => {
      await this.households.requirePricingHousehold(tx, householdId); await this.catalog.requirePricingProduct(tx, command.productId, command.unitId);
      const settings = await this.vendors.getPricingSettings(tx, vendorId);
      const price = await this.prices.createOverride(tx, { id: randomUUID(), vendorId, householdId, productId: command.productId, unitId: command.unitId, amountMinor, currency: settings.currency, ...period, reason, createdBy: actor.userId });
      await this.audit(tx, actor, vendorId, price.id, 'customer_price_override.created', 'customer_price_override', undefined, price, reason);
      return price;
    });
  }
  closeOverride(actor: Actor, vendorId: string, householdId: string, id: string, command: ClosePriceCommand) {
    const effectiveTo = this.closeInstant(command.effectiveTo); const reason = this.reason(command.reason);
    return this.execute(actor, vendorId, 'pricing:manage', 'pricing.override-close', async (tx) => {
      await this.households.requirePricingHousehold(tx, householdId); const change = await this.prices.closeOverride(tx, householdId, id, effectiveTo);
      await this.audit(tx, actor, vendorId, id, 'customer_price_override.closed', 'customer_price_override', change.before, change.after, reason);
      return change.after;
    });
  }
  resolveVendor(actor: Actor, vendorId: string, command: ResolvePriceCommand) { return this.resolve(actor, vendorId, command, false); }
  async resolveCustomer(actor: Actor, vendorId: string, householdId: string, command: Omit<ResolvePriceCommand, 'householdId'>): Promise<CustomerResolvedPrice> {
    const result = await this.resolve(actor, vendorId, { ...command, householdId }, true);
    if (result.status === 'missing') return { serviceDate: command.serviceDate, ...result };
    return { serviceDate: command.serviceDate, status: result.status, amountMinor: result.amountMinor, currency: result.currency, source: result.source };
  }

  private resolve(actor: Actor, vendorId: string, command: ResolvePriceCommand, customer: boolean): Promise<VendorResolvedPrice> {
    return this.execute(actor, vendorId, customer ? 'customer:self' : 'pricing:read', customer ? 'pricing.self-resolve' : 'pricing.resolve', async (tx) => {
      if (customer) await this.households.requireCustomerPricingHousehold(tx, actor, vendorId, command.householdId);
      else await this.households.requirePricingHousehold(tx, command.householdId);
      await this.catalog.requirePricingProduct(tx, command.productId, command.unitId);
      const [settings, slotStart] = await Promise.all([this.vendors.getPricingSettings(tx, vendorId), this.catalog.getPricingDeliverySlotStart(tx, command.deliverySlotId)]);
      const at = resolveServiceInstant(settings.timezone, command.serviceDate, slotStart);
      const price = await this.prices.resolveOverride(tx, command.householdId, command.productId, command.unitId, at) ?? await this.prices.resolveGlobal(tx, command.productId, command.unitId, at);
      if (!price) return { status: 'missing' as const };
      return { status: 'resolved' as const, amountMinor: price.amountMinor, currency: price.currency, source: 'householdId' in price ? 'customer_specific' as const : 'global' as const, sourcePriceId: price.id };
    });
  }
  private closeInstant(value: string) { return parseEffectivePeriod('0001-01-01T00:00:00Z', value).effectiveTo!; }
  private reason(value: string) { const result = value.trim(); if (result.length < 1 || result.length > 500) throw new ApplicationError('INVALID_REASON', 'Reason must be between 1 and 500 characters', 400); return result; }
  private execute<T>(actor: Actor, vendorId: string, permission: 'pricing:read' | 'pricing:manage' | 'customer:self', operation: string, work: (tx: TransactionContext) => Promise<T>) { return this.authorization.execute({ actor, vendorId, permission, operation }, work); }
  private audit(tx: Parameters<AuditWriter['append']>[0], actor: Actor, vendorId: string, entityId: string, action: string, entityType: string, oldValue?: unknown, newValue?: unknown, reason?: string) {
    return this.audits.append(tx, { id: randomUUID(), vendorId, actorUserId: actor.userId, action, entityType, entityId, ...(oldValue === undefined ? {} : { oldValue }), ...(newValue === undefined ? {} : { newValue }), ...(reason ? { reason } : {}), correlationId: requestContextStore.require().correlationId });
  }
}
