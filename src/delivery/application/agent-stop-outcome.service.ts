import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';

import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { Actor } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { HouseholdService } from '../../customers/application/household.service.js';
import { EffectiveLeaveService } from '../../leave/application/effective-leave.service.js';
import { MembershipService } from '../../memberships/application/membership.service.js';
import { NotificationWriter } from '../../notifications/application/notification-writer.js';
import { DeliveryPriceService, type DeliveryPriceEvidence } from '../../pricing/application/delivery-price.service.js';
import { VendorService } from '../../vendors/application/vendor.service.js';
import { requireAgentOutcomeQuantity, requireOutcomeReason, type AgentOutcomeStatus, type AgentSkipReason, type MissedReason } from '../domain/delivery-rules.js';
import { DeliveryStore, type DeliveryRecord, type PendingDelivery } from './delivery.store.js';

export type AgentStopOutcomeItem = Readonly<{
  scheduledDeliveryId: string;
  expectedVersion: number;
  actualQuantity?: string;
}>;

export type AgentStopOutcomeCommand = Readonly<{
  serviceDate: string;
  outcome: AgentOutcomeStatus;
  occurredAt: string;
  items: readonly AgentStopOutcomeItem[];
  reasonCode?: AgentSkipReason | MissedReason;
  note?: string;
  latitude?: number;
  longitude?: number;
}>;

export type AgentStopResult = Readonly<{
  routeStopId: string;
  serviceDate: string;
  outcome: AgentOutcomeStatus;
  items: readonly DeliveryRecord[];
}>;

export abstract class AgentStopOutcomeService {
  abstract record(actor: Actor, vendorId: string, routeStopId: string, command: AgentStopOutcomeCommand): Promise<AgentStopResult>;
}

@Injectable()
export class DefaultAgentStopOutcomeService extends AgentStopOutcomeService {
  constructor(
    @Inject(TenantAuthorizationExecutor) private readonly authorization: TenantAuthorizationExecutor,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(DeliveryStore) private readonly deliveries: DeliveryStore,
    @Inject(EffectiveLeaveService) private readonly leaves: EffectiveLeaveService,
    @Inject(DeliveryPriceService) private readonly prices: DeliveryPriceService,
    @Inject(VendorService) private readonly vendors: VendorService,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(NotificationWriter) private readonly notifications: NotificationWriter,
  ) { super(); }

  record(actor: Actor, vendorId: string, routeStopId: string, command: AgentStopOutcomeCommand): Promise<AgentStopResult> {
    return this.authorization.execute(
      { actor, vendorId, permission: 'delivery:record', operation: 'delivery.stop-outcome' },
      (tx) => this.recordInTransaction(tx, actor, vendorId, routeStopId, command),
    );
  }

  private async recordInTransaction(
    tx: TransactionContext,
    actor: Actor,
    vendorId: string,
    routeStopId: string,
    command: AgentStopOutcomeCommand,
  ): Promise<AgentStopResult> {
    const occurredAt = this.validate(command);
    const submitted = [...command.items]
      .map(({ scheduledDeliveryId, expectedVersion }) => ({ scheduledDeliveryId, expectedVersion }))
      .sort((left, right) => left.scheduledDeliveryId.localeCompare(right.scheduledDeliveryId));
    const [agent, policy] = await Promise.all([
      this.memberships.resolveSelfRouteAgent(tx, vendorId, actor.userId),
      this.vendors.getDeliveryPolicyForTransaction(tx, vendorId),
    ]);
    this.validateCoordinates(command, policy.captureAgentLocationEvidence);
    const pending = await this.deliveries.lockStopPendingSet(tx, {
      vendorId, agentMembershipId: agent.membershipId, routeStopId, serviceDate: command.serviceDate, submitted,
    });
    for (const delivery of pending) {
      if (await this.leaves.isEffectivelyOnLeave(tx, this.occurrence(delivery))) {
        throw new ApplicationError('CUSTOMER_LEAVE_EFFECTIVE', 'Customer leave is effective for this delivery', 409);
      }
    }
    const evidence = new Map<string, DeliveryPriceEvidence>();
    if (command.outcome === 'delivered') {
      for (const delivery of pending) {
        const price = await this.prices.resolve(tx, vendorId, delivery);
        if (!price) throw new ApplicationError('DELIVERY_PRICE_NOT_FOUND', 'Delivery price was not found', 409);
        evidence.set(delivery.id, price);
      }
    }
    const recipients = command.outcome === 'skipped_by_agent'
      ? await this.households.getNotificationRecipientUserIds(tx, vendorId, pending.map(({ householdId }) => householdId))
      : new Map<string, readonly string[]>();
    const receivedAt = new Date();
    const itemsById = new Map(command.items.map((item) => [item.scheduledDeliveryId, item]));
    const results: DeliveryRecord[] = [];
    for (const delivery of pending) {
      const price = evidence.get(delivery.id);
      if (price) await this.deliveries.createPriceSnapshot(tx, { vendorId, scheduledDeliveryId: delivery.id, ...price });
      const item = itemsById.get(delivery.id)!;
      results.push(await this.deliveries.appendFinalOutcome(tx, {
        id: randomUUID(), vendorId, scheduledDeliveryId: delivery.id, expectedVersion: item.expectedVersion,
        outcome: command.outcome, source: 'delivery_agent', actorUserId: actor.userId, occurredAt, receivedAt,
        ...(item.actualQuantity !== undefined ? { actualQuantity: item.actualQuantity } : {}),
        ...(command.reasonCode !== undefined ? { reasonCode: command.reasonCode } : {}),
        ...(command.note !== undefined ? { note: command.note } : {}),
        ...(command.latitude !== undefined ? { latitude: String(command.latitude), longitude: String(command.longitude) } : {}),
      }));
      if (command.outcome === 'skipped_by_agent') {
        for (const recipientUserId of recipients.get(delivery.householdId) ?? []) {
          await this.notifications.append(tx, {
            id: randomUUID(), vendorId, householdId: delivery.householdId, recipientUserId, type: 'agent_reported_skip', payload: { scheduledDeliveryId: delivery.id },
          });
        }
      }
    }
    return { routeStopId, serviceDate: command.serviceDate, outcome: command.outcome, items: results };
  }

  private validate(command: AgentStopOutcomeCommand): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(command.serviceDate) || !DateTime.fromISO(command.serviceDate, { zone: 'UTC' }).isValid) {
      throw new ApplicationError('INVALID_DELIVERY_DATE', 'Delivery service date is invalid', 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(command.occurredAt)) {
      throw new ApplicationError('INVALID_DELIVERY_OCCURRENCE_TIME', 'Delivery occurrence time must be RFC3339', 400);
    }
    const instant = DateTime.fromISO(command.occurredAt, { setZone: true });
    if (!instant.isValid || command.items.length === 0) {
      throw new ApplicationError('INVALID_DELIVERY_OCCURRENCE_TIME', 'Delivery occurrence time or item set is invalid', 400);
    }
    const ids = new Set<string>();
    for (const item of command.items) {
      if (ids.has(item.scheduledDeliveryId)) throw new ApplicationError('INCOMPLETE_STOP_SET', 'Delivery items must be unique', 409);
      ids.add(item.scheduledDeliveryId);
      if (!Number.isInteger(item.expectedVersion) || item.expectedVersion < 1) throw new ApplicationError('STALE_VERSION', 'Delivery version is invalid', 409);
      requireAgentOutcomeQuantity(command.outcome, item.actualQuantity);
    }
    if (command.outcome === 'delivered') {
      if (command.reasonCode !== undefined || command.note !== undefined || command.latitude !== undefined || command.longitude !== undefined) {
        throw new ApplicationError('INVALID_DELIVERY_OUTCOME', 'Delivered outcomes contain unsupported fields', 400);
      }
    } else {
      requireOutcomeReason(command.outcome, command.reasonCode, command.note);
    }
    return instant.toJSDate();
  }

  private validateCoordinates(command: AgentStopOutcomeCommand, enabled: boolean): void {
    if (command.outcome === 'delivered') return;
    if ((command.latitude === undefined) !== (command.longitude === undefined)) {
      throw new ApplicationError('INVALID_DELIVERY_COORDINATES', 'Latitude and longitude must be provided together', 400);
    }
    if (command.latitude === undefined) return;
    if (!Number.isFinite(command.latitude) || !Number.isFinite(command.longitude)
      || command.latitude < -90 || command.latitude > 90 || command.longitude! < -180 || command.longitude! > 180) {
      throw new ApplicationError('INVALID_DELIVERY_COORDINATES', 'Coordinates are invalid', 400);
    }
    if (!enabled) throw new ApplicationError('DELIVERY_LOCATION_EVIDENCE_DISABLED', 'Location evidence is disabled', 400);
  }

  private occurrence(delivery: PendingDelivery) {
    return {
      vendorId: delivery.vendorId, subscriptionId: delivery.subscriptionId,
      serviceDate: delivery.serviceDate, deliverySlotId: delivery.deliverySlotId,
    };
  }
}
