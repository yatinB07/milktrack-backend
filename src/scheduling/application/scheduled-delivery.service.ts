import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { Actor } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { MembershipService } from '../../memberships/application/membership.service.js';
import { VendorService } from '../../vendors/application/vendor.service.js';
import { validateScheduleDate } from '../domain/schedule-date.js';
import { ScheduledDeliveryStore } from './scheduled-delivery.store.js';

export abstract class ScheduledDeliveryService {
  abstract listSelf(
    actor: Actor,
    vendorId: string,
    serviceDate: string | undefined,
    query: Readonly<{ cursor?: string; limit?: number }>,
  ): Promise<Awaited<ReturnType<ScheduledDeliveryStore['listSelf']>> & Readonly<{ serviceDate: string }>>;
}

@Injectable()
export class DefaultScheduledDeliveryService extends ScheduledDeliveryService {
  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(ScheduledDeliveryStore) private readonly deliveries: ScheduledDeliveryStore,
    @Inject(VendorService) private readonly vendors: VendorService,
  ) { super(); }

  listSelf(actor: Actor, vendorId: string, serviceDate: string | undefined, query: Readonly<{ cursor?: string; limit?: number }>) {
    return this.authorization.execute(
      { actor, vendorId, permission: 'delivery:read', operation: 'schedule.self-list' },
      async (transaction) => {
        const effectiveServiceDate = serviceDate ?? await this.today(transaction, vendorId);
        validateScheduleDate(effectiveServiceDate);
        const membership = await this.memberships.resolveSelfRouteAgent(transaction, vendorId, actor.userId);
        const page = await this.deliveries.listSelf(transaction, vendorId, membership.membershipId, effectiveServiceDate, query);
        return { ...page, serviceDate: effectiveServiceDate };
      },
    );
  }

  private async today(transaction: TransactionContext, vendorId: string) {
    const { timezone } = await this.vendors.getSubscriptionTimezone(transaction, vendorId);
    const today = DateTime.now().setZone(timezone).toISODate();
    if (!today) throw new ApplicationError('VENDOR_TIMEZONE_INVALID', 'Vendor timezone is invalid', 503);
    return today;
  }
}
