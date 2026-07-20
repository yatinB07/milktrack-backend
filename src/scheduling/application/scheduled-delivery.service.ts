import { Inject, Injectable } from '@nestjs/common';

import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import type { Actor } from '../../common/context/request-context.js';
import { MembershipService } from '../../memberships/application/membership.service.js';
import { validateScheduleDate } from '../domain/schedule-date.js';
import { ScheduledDeliveryStore } from './scheduled-delivery.store.js';

export abstract class ScheduledDeliveryService {
  abstract listSelf(
    actor: Actor,
    vendorId: string,
    serviceDate: string,
    query: Readonly<{ cursor?: string; limit?: number }>,
  ): ReturnType<ScheduledDeliveryStore['listSelf']>;
}

@Injectable()
export class DefaultScheduledDeliveryService extends ScheduledDeliveryService {
  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(ScheduledDeliveryStore) private readonly deliveries: ScheduledDeliveryStore,
  ) { super(); }

  listSelf(actor: Actor, vendorId: string, serviceDate: string, query: Readonly<{ cursor?: string; limit?: number }>) {
    validateScheduleDate(serviceDate);
    return this.authorization.execute(
      { actor, vendorId, permission: 'delivery:read', operation: 'schedule.self-list' },
      async (transaction) => {
        const membership = await this.memberships.resolveSelfRouteAgent(transaction, vendorId, actor.userId);
        return this.deliveries.listSelf(transaction, vendorId, membership.membershipId, serviceDate, query);
      },
    );
  }
}
