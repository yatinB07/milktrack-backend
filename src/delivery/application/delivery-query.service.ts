import { Inject, Injectable } from '@nestjs/common';

import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { Actor } from '../../common/context/request-context.js';
import { HouseholdService } from '../../customers/application/household.service.js';
import {
  DeliveryStore,
  type CustomerDeliveryQuery,
  type DeliveryDetail,
  type DeliveryPage,
  type VendorDeliveryQuery,
} from './delivery.store.js';

@Injectable()
export class DeliveryQueryService {
  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(DeliveryStore) private readonly deliveries: DeliveryStore,
    @Inject(HouseholdService) private readonly households: HouseholdService,
  ) {}

  listVendor(actor: Actor, vendorId: string, query: Omit<VendorDeliveryQuery, 'vendorId'>): Promise<DeliveryPage> {
    return this.vendor(actor, vendorId, (tx) => this.deliveries.listVendor(tx, { vendorId, ...query }));
  }

  getVendorDetail(actor: Actor, vendorId: string, id: string): Promise<DeliveryDetail> {
    return this.vendor(actor, vendorId, (tx) => this.deliveries.getVendorDetail(tx, vendorId, id));
  }

  listCustomer(actor: Actor, vendorId: string, householdId: string, query: Omit<CustomerDeliveryQuery, 'vendorId' | 'householdId'>): Promise<DeliveryPage> {
    return this.customer(actor, vendorId, householdId, (tx) => this.deliveries.listCustomer(tx, { vendorId, householdId, ...query }));
  }

  getCustomerDetail(actor: Actor, vendorId: string, householdId: string, id: string): Promise<DeliveryDetail> {
    return this.customer(actor, vendorId, householdId, (tx) => this.deliveries.getCustomerDetail(tx, vendorId, householdId, id));
  }

  private vendor<T>(actor: Actor, vendorId: string, work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.authorization.execute({ actor, vendorId, permission: 'schedule:read', operation: 'schedule.run-list' }, work);
  }

  private customer<T>(actor: Actor, vendorId: string, householdId: string, work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.authorization.execute({ actor, vendorId, permission: 'customer:self', operation: 'subscription.self-list' }, async (tx) => {
      await this.households.requireCustomerSubscriptionHousehold(tx, actor, vendorId, householdId);
      return work(tx);
    });
  }
}
