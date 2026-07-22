import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  RouteAssignmentStore,
  type AgentRouteAssignmentRecord,
  type RouteAssignmentPageQuery,
  type RouteAssignmentRecord,
  type RouteAssignmentStatus,
  type RouteScheduleProjection,
} from '../application/route-assignment.store.js';
import type { RouteRecord } from '../application/route.store.js';

const error = (code: string, message: string, status: number) => new ApplicationError(code, message, status);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type Cursor = Readonly<{ serviceDate: string; id: string }>;
type Row = {
  id: string;
  routeId: string;
  deliverySlotId: string;
  agentMembershipId: string;
  serviceDate: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};
type AgentRow = Row & {
  routeCode: string;
  routeName: string;
  deliverySlotName: string;
  deliverySlotStartLocalTime: string;
  deliverySlotEndLocalTime: string;
};
type ScheduleRow = {
  routeId: string;
  routeVersion: number;
  deliverySlotId: string;
  assignmentId: string | null;
  agentMembershipId: string | null;
  stopId: string | null;
  householdId: string | null;
  sequence: number | null;
};

@Injectable()
export class PrismaRouteAssignmentStore extends RouteAssignmentStore {
  async list(context: TransactionContext, route: RouteRecord, query: RouteAssignmentPageQuery) {
    const tx = unwrapPrismaTransaction(context);
    const limit = this.limit(query.limit);
    const cursor = query.cursor ? this.decode(query.cursor) : undefined;
    const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT id,route_id AS "routeId",delivery_slot_id AS "deliverySlotId",agent_membership_id AS "agentMembershipId",
        service_date::text AS "serviceDate",status,created_at AS "createdAt",updated_at AS "updatedAt"
      FROM route_assignments WHERE route_id=${route.id}::uuid
        ${query.fromDate ? Prisma.sql`AND service_date >= ${query.fromDate}::date` : Prisma.empty}
        ${query.toDate ? Prisma.sql`AND service_date <= ${query.toDate}::date` : Prisma.empty}
        ${query.status ? Prisma.sql`AND status=${query.status}` : Prisma.empty}
        ${cursor ? Prisma.sql`AND (service_date < ${cursor.serviceDate}::date OR (service_date=${cursor.serviceDate}::date AND id < ${cursor.id}::uuid))` : Prisma.empty}
      ORDER BY service_date DESC,id DESC LIMIT ${limit + 1}`);
    return this.page(rows, limit);
  }

  async listSelf(context: TransactionContext, agentMembershipId: string, serviceDate: string, query: Readonly<{ cursor?: string; limit?: number }>) {
    const tx = unwrapPrismaTransaction(context);
    const limit = this.limit(query.limit);
    const cursor = query.cursor ? this.decode(query.cursor) : undefined;
    const rows = await tx.$queryRaw<AgentRow[]>(Prisma.sql`
      SELECT a.id,a.route_id AS "routeId",a.delivery_slot_id AS "deliverySlotId",a.agent_membership_id AS "agentMembershipId",
        a.service_date::text AS "serviceDate",a.status,a.created_at AS "createdAt",a.updated_at AS "updatedAt",
        r.code AS "routeCode",r.name AS "routeName",d.name AS "deliverySlotName",
        to_char(d.start_local_time,'HH24:MI') AS "deliverySlotStartLocalTime",
        to_char(d.end_local_time,'HH24:MI') AS "deliverySlotEndLocalTime"
      FROM route_assignments a
      JOIN routes r ON r.id=a.route_id AND r.vendor_id=a.vendor_id AND r.delivery_slot_id=a.delivery_slot_id
      JOIN delivery_slots d ON d.id=a.delivery_slot_id AND d.vendor_id=a.vendor_id
      WHERE a.agent_membership_id=${agentMembershipId}::uuid AND a.service_date=${serviceDate}::date AND a.status='assigned'
        ${cursor ? Prisma.sql`AND (a.service_date < ${cursor.serviceDate}::date OR (a.service_date=${cursor.serviceDate}::date AND a.id < ${cursor.id}::uuid))` : Prisma.empty}
      ORDER BY a.service_date DESC,a.id DESC LIMIT ${limit + 1}`);
    return this.agentPage(rows, limit);
  }

  async assign(
    context: TransactionContext,
    input: Readonly<{ route: RouteRecord; serviceDate: string; agentMembershipId: string; actorId: string }>,
  ) {
    const tx = unwrapPrismaTransaction(context);
    await this.lock(tx, `routing-vendor-slot:${input.route.vendorId}:${input.route.deliverySlotId}`);
    const previous = await this.current(context, input.route.id, input.serviceDate);
    const membershipIds = [
      ...new Set(
        [previous?.agentMembershipId, input.agentMembershipId].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ].sort();
    for (const membershipId of membershipIds) {
      await this.lock(tx, `routing-agent:${input.route.vendorId}:${membershipId}:${input.route.deliverySlotId}:${input.serviceDate}`);
    }
    if (
      previous?.status === 'assigned'
      && previous.agentMembershipId.toLowerCase() === input.agentMembershipId.toLowerCase()
    ) {
      throw error('ROUTE_STATE_CONFLICT', 'Route assignment already has this agent', 409);
    }
    try {
      const row = previous
        ? await tx.routeAssignment.update({
            where: { id: previous.id },
            data: {
              agentMembershipId: input.agentMembershipId,
              status: 'assigned',
              updatedBy: input.actorId,
              cancelledAt: null,
              cancellationReason: null,
            },
          })
        : await tx.routeAssignment.create({
            data: {
              id: randomUUID(),
              vendorId: input.route.vendorId,
              routeId: input.route.id,
              deliverySlotId: input.route.deliverySlotId,
              agentMembershipId: input.agentMembershipId,
              serviceDate: new Date(`${input.serviceDate}T00:00:00.000Z`),
              createdBy: input.actorId,
              updatedBy: input.actorId,
            },
          });
      const route = await tx.route.update({
        where: { id: input.route.id },
        data: { version: { increment: 1 } },
        select: { version: true },
      });
      return { assignment: this.record(row), routeVersion: route.version, created: !previous, ...(previous ? { previous } : {}) };
    } catch (cause) {
      this.translate(cause);
      throw cause;
    }
  }

  async cancel(context: TransactionContext, input: Readonly<{ route: RouteRecord; serviceDate: string; actorId: string; reason: string }>) {
    const tx = unwrapPrismaTransaction(context);
    await this.lock(tx, `routing-vendor-slot:${input.route.vendorId}:${input.route.deliverySlotId}`);
    const previous = await this.current(context, input.route.id, input.serviceDate);
    if (!previous) {
      throw error('ROUTE_ASSIGNMENT_NOT_FOUND', 'Route assignment was not found', 404);
    }
    await this.lock(tx, `routing-agent:${input.route.vendorId}:${previous.agentMembershipId}:${input.route.deliverySlotId}:${input.serviceDate}`);
    if (previous.status === 'cancelled') {
      throw error('ROUTE_STATE_CONFLICT', 'Route assignment is already cancelled', 409);
    }
    const row = await tx.routeAssignment.update({
      where: { id: previous.id },
      data: {
        status: 'cancelled',
        updatedBy: input.actorId,
        cancelledAt: new Date(),
        cancellationReason: input.reason,
      },
    });
    const route = await tx.route.update({
      where: { id: input.route.id },
      data: { version: { increment: 1 } },
      select: { version: true },
    });
    return { assignment: this.record(row), routeVersion: route.version, created: false, previous };
  }

  async hasAssignedOnOrAfter(context: TransactionContext, routeId: string, today: string) {
    return (await unwrapPrismaTransaction(context).routeAssignment.count({
      where: {
        routeId,
        status: 'assigned',
        serviceDate: { gte: new Date(`${today}T00:00:00.000Z`) },
      },
    })) > 0;
  }

  async schedule(
    context: TransactionContext,
    vendorId: string,
    serviceDate: string,
  ): Promise<readonly RouteScheduleProjection[]> {
    const rows = await unwrapPrismaTransaction(context).$queryRaw<ScheduleRow[]>(Prisma.sql`
      SELECT r.id AS "routeId",r.version AS "routeVersion",r.delivery_slot_id AS "deliverySlotId",
        a.id AS "assignmentId",a.agent_membership_id AS "agentMembershipId",s.id AS "stopId",s.household_id AS "householdId",s.sequence
      FROM routes r
      LEFT JOIN route_assignments a ON a.route_id=r.id AND a.service_date=${serviceDate}::date AND a.status='assigned'
      LEFT JOIN LATERAL (SELECT id FROM route_stop_plans WHERE route_id=r.id AND superseded_at IS NULL AND effective_from<=${serviceDate}::date AND (effective_to IS NULL OR effective_to>${serviceDate}::date) ORDER BY effective_from DESC,id DESC LIMIT 1) p ON true
      LEFT JOIN route_stops s ON s.plan_id=p.id AND s.superseded_at IS NULL
      WHERE r.vendor_id=${vendorId}::uuid AND r.status='active' AND r.deleted_at IS NULL
      ORDER BY r.id,s.sequence,s.id`);
    return this.projections(rows);
  }

  async projectRoute(
    context: TransactionContext,
    vendorId: string,
    routeId: string,
    serviceDate: string,
  ): Promise<RouteScheduleProjection | undefined> {
    const rows = await unwrapPrismaTransaction(context).$queryRaw<ScheduleRow[]>(Prisma.sql`
      SELECT r.id AS "routeId",r.version AS "routeVersion",r.delivery_slot_id AS "deliverySlotId",
        a.id AS "assignmentId",a.agent_membership_id AS "agentMembershipId",s.id AS "stopId",s.household_id AS "householdId",s.sequence
      FROM routes r
      LEFT JOIN route_assignments a ON a.route_id=r.id AND a.service_date=${serviceDate}::date AND a.status='assigned'
      LEFT JOIN LATERAL (SELECT id FROM route_stop_plans WHERE route_id=r.id AND superseded_at IS NULL AND effective_from<=${serviceDate}::date AND (effective_to IS NULL OR effective_to>${serviceDate}::date) ORDER BY effective_from DESC,id DESC LIMIT 1) p ON true
      LEFT JOIN route_stops s ON s.plan_id=p.id AND s.superseded_at IS NULL
      WHERE r.vendor_id=${vendorId}::uuid AND r.id=${routeId}::uuid
        AND r.status='active' AND r.deleted_at IS NULL
      ORDER BY s.sequence,s.id`);
    return this.projections(rows)[0];
  }

  private projections(rows: readonly ScheduleRow[]): readonly RouteScheduleProjection[] {
    const routes = new Map<string, RouteScheduleProjection>();
    for (const row of rows) {
      const existing = routes.get(row.routeId);
      const stops = existing ? [...existing.stops] : [];
      if (row.stopId && row.householdId && row.sequence) {
        stops.push({ stopId: row.stopId, householdId: row.householdId, sequence: row.sequence });
      }
      routes.set(row.routeId, {
        routeId: row.routeId,
        routeVersion: row.routeVersion,
        deliverySlotId: row.deliverySlotId,
        stops,
        ...(row.assignmentId && row.agentMembershipId
          ? { assignment: { assignmentId: row.assignmentId, agentMembershipId: row.agentMembershipId } }
          : {}),
      });
    }
    return [...routes.values()];
  }

  private async current(context: TransactionContext, routeId: string, serviceDate: string) {
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT id,route_id AS "routeId",delivery_slot_id AS "deliverySlotId",agent_membership_id AS "agentMembershipId",service_date::text AS "serviceDate",status,created_at AS "createdAt",updated_at AS "updatedAt" FROM route_assignments WHERE route_id=${routeId}::uuid AND service_date=${serviceDate}::date FOR UPDATE`);
    return rows[0] ? this.row(rows[0]) : undefined;
  }

  private lock(tx: ReturnType<typeof unwrapPrismaTransaction>, key: string) {
    return tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`);
  }

  private record(row: {
    id: string;
    routeId: string;
    deliverySlotId: string;
    agentMembershipId: string;
    serviceDate: Date;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }): RouteAssignmentRecord {
    return {
      id: row.id,
      routeId: row.routeId,
      deliverySlotId: row.deliverySlotId,
      agentMembershipId: row.agentMembershipId,
      serviceDate: row.serviceDate.toISOString().slice(0, 10),
      status: row.status as RouteAssignmentStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private row(row: Row): RouteAssignmentRecord {
    return { ...row, status: row.status as RouteAssignmentStatus };
  }

  private page(rows: Row[], limit: number) {
    const items = rows.slice(0, limit).map((row) => this.row(row));
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > limit && last
        ? { nextCursor: this.encode({ serviceDate: last.serviceDate, id: last.id }) }
        : {}),
    };
  }

  private agentPage(rows: AgentRow[], limit: number) {
    const items = rows.slice(0, limit).map((row) => this.agentRow(row));
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > limit && last
        ? { nextCursor: this.encode({ serviceDate: last.serviceDate, id: last.id }) }
        : {}),
    };
  }

  private agentRow(row: AgentRow): AgentRouteAssignmentRecord {
    return { ...row, status: row.status as RouteAssignmentStatus };
  }

  private limit(value?: number) {
    const limit = value ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw error('INVALID_PAGINATION', 'Limit must be between 1 and 100', 400);
    }
    return limit;
  }

  private encode(value: Cursor) {
    return Buffer.from(JSON.stringify([value.serviceDate, value.id])).toString('base64url');
  }

  private decode(value: string): Cursor {
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
      const decoded = Buffer.from(value, 'base64url');
      if (decoded.toString('base64url') !== value) throw new Error();
      const parsed: unknown = JSON.parse(decoded.toString('utf8'));
      if (
        !Array.isArray(parsed)
        || parsed.length !== 2
        || typeof parsed[0] !== 'string'
        || typeof parsed[1] !== 'string'
        || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(parsed[0])
        || new Date(`${parsed[0]}T00:00:00.000Z`).toISOString().slice(0, 10) !== parsed[0]
        || !uuid.test(parsed[1])
      ) throw new Error();
      return { serviceDate: parsed[0], id: parsed[1] };
    } catch {
      throw error('INVALID_CURSOR', 'Cursor is invalid', 400);
    }
  }

  private translate(cause: unknown) {
    const details = this.details(cause);
    if (
      details.includes('route_assignments_vendor_id_route_id_service_date_key')
      || details.includes('route_assignments_agent_slot_date_assigned_key')
      || details.includes('P2002')
    ) {
      throw error('ROUTE_ASSIGNMENT_CONFLICT', 'Route assignment conflicts with an existing assignment', 409);
    }
  }

  private details(value: unknown, seen = new Set<unknown>()): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' || typeof value === 'symbol') {
      return value.toString();
    }
    if (typeof value === 'function') return value.name;
    if (seen.has(value)) return '';
    seen.add(value);
    return Object.values(value as Record<string, unknown>)
      .map((item) => this.details(item, seen))
      .join(' ');
  }
}
