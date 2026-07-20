import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import { ScheduledDeliveryStore, type AgentScheduledDelivery } from '../application/scheduled-delivery.store.js';
import { planScheduleReconciliation, type ScheduledDeliveryState, type ScheduleTarget } from '../domain/schedule-reconciliation.js';

type DeliveryRow = Omit<ScheduledDeliveryState, 'finalized'> & { finalized: boolean };
type AgentCursor = Readonly<{ sequence: number; id: string }>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

@Injectable()
export class PrismaScheduledDeliveryStore extends ScheduledDeliveryStore {
  async reconcile(context: TransactionContext, vendorId: string, serviceDate: string, targets: ScheduleTarget[]) {
    const tx = unwrapPrismaTransaction(context);
    const current = await tx.$queryRaw<DeliveryRow[]>(Prisma.sql`
      SELECT id,subscription_id AS "subscriptionId",subscription_revision_id AS "revisionId",
        household_id AS "householdId",product_id AS "productId",unit_id AS "unitId",
        delivery_slot_id AS "deliverySlotId",planned_quantity::text AS "plannedQuantity",
        route_assignment_id AS "routeAssignmentId",status,version,(finalized_at IS NOT NULL) AS finalized
      FROM scheduled_deliveries
      WHERE vendor_id=${vendorId}::uuid AND service_date=${serviceDate}::date
      ORDER BY subscription_id,delivery_slot_id,id FOR UPDATE`);
    const plan = planScheduleReconciliation(
      current.map((delivery) => ({ ...delivery, plannedQuantity: canonicalDecimal(delivery.plannedQuantity) })),
      targets,
    );
    const created = plan.created.map((target) => ({ id: randomUUID(), ...target }));
    const inserted = created.length === 0 ? 0 : await tx.$executeRaw(Prisma.sql`
      INSERT INTO scheduled_deliveries (
        id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,
        delivery_slot_id,route_assignment_id,service_date,planned_quantity,status,version,updated_at
      ) SELECT c.id,${vendorId}::uuid,c."subscriptionId",c."revisionId",c."householdId",c."productId",c."unitId",
        c."deliverySlotId",c."routeAssignmentId",${serviceDate}::date,c."plannedQuantity",'scheduled',1,CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${JSON.stringify(created)}::jsonb) AS c(
        id uuid,"subscriptionId" uuid,"revisionId" uuid,"householdId" uuid,"productId" uuid,"unitId" uuid,
        "deliverySlotId" uuid,"routeAssignmentId" uuid,"plannedQuantity" numeric(18,3)
      ) ON CONFLICT ON CONSTRAINT scheduled_deliveries_business_key DO NOTHING`);
    const updated = plan.updated.length === 0 ? 0 : await tx.$executeRaw(Prisma.sql`
      UPDATE scheduled_deliveries d SET subscription_revision_id=c."revisionId",household_id=c."householdId",
        product_id=c."productId",unit_id=c."unitId",route_assignment_id=c."routeAssignmentId",
        planned_quantity=c."plannedQuantity",status='scheduled',cancelled_at=NULL,cancellation_reason=NULL,
        version=d.version+1,updated_at=CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${JSON.stringify(plan.updated)}::jsonb) AS c(
        id uuid,"revisionId" uuid,"householdId" uuid,"productId" uuid,"unitId" uuid,
        "routeAssignmentId" uuid,"plannedQuantity" numeric(18,3)
      ) WHERE d.id=c.id AND d.vendor_id=${vendorId}::uuid AND d.finalized_at IS NULL`);
    const cancelled = plan.cancelled.length === 0 ? 0 : await tx.$executeRaw(Prisma.sql`
      UPDATE scheduled_deliveries SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,
        cancellation_reason='Subscription no longer applies',version=version+1,updated_at=CURRENT_TIMESTAMP
      WHERE vendor_id=${vendorId}::uuid AND finalized_at IS NULL AND status='scheduled'
        AND id=ANY(${plan.cancelled.map(({ id }) => id)}::uuid[])`);
    return {
      created: inserted,
      existing: plan.existing.length + created.length - inserted,
      updated,
      cancelled,
    };
  }

  async listSelf(
    context: TransactionContext,
    vendorId: string,
    agentMembershipId: string,
    serviceDate: string,
    query: Readonly<{ cursor?: string; limit?: number }>,
  ) {
    const tx = unwrapPrismaTransaction(context);
    const limit = this.limit(query.limit);
    const cursor = query.cursor ? this.decode(query.cursor) : undefined;
    const rows = await tx.$queryRaw<AgentScheduledDelivery[]>(Prisma.sql`
      SELECT d.id,d.subscription_id AS "subscriptionId",d.household_id AS "householdId",
        d.product_id AS "productId",d.unit_id AS "unitId",d.delivery_slot_id AS "deliverySlotId",
        d.route_assignment_id AS "routeAssignmentId",s.id AS "routeStopId",
        d.service_date::text AS "serviceDate",d.planned_quantity::text AS "plannedQuantity",s.sequence
      FROM scheduled_deliveries d
      JOIN route_assignments a ON a.vendor_id=d.vendor_id AND a.id=d.route_assignment_id
        AND a.service_date=d.service_date AND a.delivery_slot_id=d.delivery_slot_id
        AND a.agent_membership_id=${agentMembershipId}::uuid AND a.status='assigned'
      JOIN LATERAL (
        SELECT p.id FROM route_stop_plans p
        WHERE p.vendor_id=d.vendor_id AND p.route_id=a.route_id AND p.delivery_slot_id=d.delivery_slot_id
          AND p.superseded_at IS NULL AND p.effective_from<=d.service_date
          AND (p.effective_to IS NULL OR p.effective_to>d.service_date)
        ORDER BY p.effective_from DESC,p.id DESC LIMIT 1
      ) p ON true
      JOIN route_stops s ON s.vendor_id=d.vendor_id AND s.route_id=a.route_id AND s.plan_id=p.id
        AND s.household_id=d.household_id AND s.delivery_slot_id=d.delivery_slot_id
        AND s.superseded_at IS NULL AND s.effective_from<=d.service_date
        AND (s.effective_to IS NULL OR s.effective_to>d.service_date)
      WHERE d.vendor_id=${vendorId}::uuid AND d.service_date=${serviceDate}::date AND d.status='scheduled'
        ${cursor ? Prisma.sql`AND (s.sequence>${cursor.sequence} OR (s.sequence=${cursor.sequence} AND d.id>${cursor.id}::uuid))` : Prisma.empty}
      ORDER BY s.sequence,d.id LIMIT ${limit + 1}`);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { nextCursor: this.encode(last) } : {}) };
  }

  private limit(value?: number) {
    const limit = value ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApplicationError('INVALID_PAGINATION', 'Limit must be between 1 and 100', 400);
    }
    return limit;
  }

  private encode(value: AgentCursor) {
    return Buffer.from(JSON.stringify([value.sequence, value.id])).toString('base64url');
  }

  private decode(value: string): AgentCursor {
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.toString('base64url') !== value) throw new Error();
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isInteger(parsed[0]) || parsed[0] < 1 || typeof parsed[1] !== 'string' || !uuid.test(parsed[1])) throw new Error();
      return { sequence: parsed[0] as number, id: parsed[1] };
    } catch {
      throw new ApplicationError('INVALID_CURSOR', 'Cursor is invalid', 400);
    }
  }
}

function canonicalDecimal(value: string) {
  const [integer = '', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/u, '');
  return trimmed ? `${integer}.${trimmed}` : integer;
}
