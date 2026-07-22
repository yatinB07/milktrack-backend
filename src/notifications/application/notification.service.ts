import { Inject, Injectable } from '@nestjs/common';

import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import type { Actor } from '../../common/context/request-context.js';
import { HouseholdService, type PageQuery } from '../../customers/application/household.service.js';
import { PrismaNotificationStore, type NotificationPage } from '../infrastructure/prisma-notification.store.js';

export type { NotificationPage };

export abstract class NotificationService {
  abstract listCustomer(actor: Actor, vendorId: string, householdId: string, query: PageQuery): Promise<NotificationPage>;
}

@Injectable()
export class DefaultNotificationService extends NotificationService {
  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(PrismaNotificationStore) private readonly notifications: PrismaNotificationStore,
  ) { super(); }

  listCustomer(actor: Actor, vendorId: string, householdId: string, query: PageQuery) {
    return this.authorization.execute({ actor, vendorId, permission: 'customer:self', operation: 'notification.self-list' }, async (tx) => {
      await this.households.requireCustomerSubscriptionHousehold(tx, actor, vendorId, householdId);
      return this.notifications.list(tx, vendorId, actor.userId, query);
    });
  }
}
