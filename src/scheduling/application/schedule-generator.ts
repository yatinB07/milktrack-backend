import { Inject, Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { SchedulingLeaveService } from '../../leave/application/scheduling-leave.service.js';
import { SchedulingPriceService } from '../../pricing/application/scheduling-price.service.js';
import { RoutingScheduleService } from '../../routing/application/routing-schedule.service.js';
import { ScheduleDateLock } from '../../schedule-coordination/application/schedule-date-lock.js';
import { SubscriptionScheduleService } from '../../subscriptions/application/subscription-schedule.service.js';
import { validateScheduleDate } from '../domain/schedule-date.js';
import { ScheduledDeliveryStore } from './scheduled-delivery.store.js';

export type ScheduleGenerationResult = Readonly<{
  created: number; existing: number; updated: number; cancelled: number; missingPrice: number;
}>;

export abstract class ScheduleGenerator {
  abstract generate(
    transaction: TransactionContext,
    vendorId: string,
    serviceDate: string,
  ): Promise<ScheduleGenerationResult>;
}

@Injectable()
export class DefaultScheduleGenerator extends ScheduleGenerator {
  constructor(
    @Inject(ScheduleDateLock) private readonly dates: ScheduleDateLock,
    @Inject(SubscriptionScheduleService) private readonly subscriptions: SubscriptionScheduleService,
    @Inject(RoutingScheduleService) private readonly routing: RoutingScheduleService,
    @Inject(SchedulingPriceService) private readonly pricing: SchedulingPriceService,
    @Inject(SchedulingLeaveService) private readonly leave: SchedulingLeaveService,
    @Inject(ScheduledDeliveryStore) private readonly deliveries: ScheduledDeliveryStore,
  ) { super(); }

  async generate(transaction: TransactionContext, vendorId: string, serviceDate: string) {
    validateScheduleDate(serviceDate);
    await this.dates.lock(transaction, vendorId, [serviceDate]);
    const subscriptions = await this.subscriptions.project(transaction, vendorId, serviceDate);
    const routes = await this.routing.project(transaction, vendorId, serviceDate);
    const assignmentByStop = new Map<string, string>();
    for (const route of routes) {
      if (!route.assignment) continue;
      for (const stop of route.stops) {
        assignmentByStop.set(`${route.deliverySlotId}:${stop.householdId}`, route.assignment.assignmentId);
      }
    }
    const targets = subscriptions.map((candidate) => ({
      ...candidate,
      routeAssignmentId: assignmentByStop.get(`${candidate.deliverySlotId}:${candidate.householdId}`) ?? null,
    }));
    const availability = await this.pricing.resolveMany(transaction, vendorId, serviceDate, targets);
    const effectiveLeave = await this.leave.effectiveOccurrences(transaction, vendorId, serviceDate, targets);
    const counts = await this.deliveries.reconcile(transaction, vendorId, serviceDate, targets, effectiveLeave);
    return { ...counts, missingPrice: availability.filter(({ status }) => status === 'missing').length };
  }
}
