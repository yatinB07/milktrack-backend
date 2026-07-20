import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import { publicRouteStopPeriod } from '../domain/route-stop-rules.js';
import { RouteStopPlanStore, type ReplaceRouteStopsInput, type RouteStopPageQuery } from '../application/route-stop-plan.store.js';
import type { RouteRecord } from '../application/route.store.js';

type PlanRow = { id: string; effectiveFrom: string; effectiveTo: string | null };
type StopRow = { id: string; householdId: string; sequence: number };
const error = (code: string, message: string, status: number) => new ApplicationError(code, message, status);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type StopCursor = Readonly<{ sequence: number; id: string }>;

@Injectable()
export class PrismaRouteStopPlanStore extends RouteStopPlanStore {
  async list(context: TransactionContext, route: RouteRecord, query: RouteStopPageQuery) {
    const tx = unwrapPrismaTransaction(context);
    const limit = this.limit(query.limit); const cursor = query.cursor ? this.decode(query.cursor) : undefined;
    const plans = await this.plans(context, route.id, query.serviceDate);
    const plan = plans[0];
    const stops = plan ? await tx.$queryRaw<StopRow[]>(Prisma.sql`
      SELECT id, household_id AS "householdId", sequence
      FROM route_stops WHERE plan_id=${plan.id}::uuid AND superseded_at IS NULL
        ${cursor ? Prisma.sql`AND (sequence > ${cursor.sequence} OR (sequence = ${cursor.sequence} AND id > ${cursor.id}::uuid))` : Prisma.empty}
      ORDER BY sequence, id LIMIT ${limit + 1}`) : [];
    const items=stops.slice(0,limit),last=items.at(-1);
    return {
      routeId: route.id,
      routeVersion: route.version,
      deliverySlotId: route.deliverySlotId,
      serviceDate: query.serviceDate,
      ...(plan ? publicRouteStopPeriod(plan.effectiveFrom, plan.effectiveTo ?? undefined) : {}),
      stops: items,
      ...(stops.length > limit && last ? { nextCursor: this.encode(last) } : {}),
    };
  }

  async replace(context: TransactionContext, input: ReplaceRouteStopsInput) {
    const tx = unwrapPrismaTransaction(context);
    const planId = randomUUID();
    try {
      // WU3 route assignments use this same namespace so all vendor/slot routing mutations serialize.
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('routing-vendor-slot:' || ${input.route.vendorId}::text || ':' || ${input.route.deliverySlotId}::text,0))::text`);
      const previous = await this.snapshot(context,input.route,input.effectiveDate);
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM route_stop_plans WHERE route_id=${input.route.id}::uuid AND superseded_at IS NULL
        ORDER BY effective_from, id FOR UPDATE`);
      await tx.$executeRaw(Prisma.sql`
        UPDATE route_stop_plans SET effective_to=${input.effectiveDate}::date, updated_at=now()
        WHERE route_id=${input.route.id}::uuid AND superseded_at IS NULL
          AND effective_from < ${input.effectiveDate}::date
          AND (effective_to IS NULL OR effective_to > ${input.effectiveDate}::date)`);
      await tx.$executeRaw(Prisma.sql`
        UPDATE route_stop_plans SET superseded_at=now(), superseded_by_plan_id=${planId}::uuid,
          supersession_reason=${input.reason}, updated_at=now()
        WHERE route_id=${input.route.id}::uuid AND superseded_at IS NULL
          AND effective_from >= ${input.effectiveDate}::date`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO route_stop_plans (id, vendor_id, route_id, delivery_slot_id, effective_from,
          created_by, created_at, updated_at)
        VALUES (${planId}::uuid, ${input.route.vendorId}::uuid, ${input.route.id}::uuid,
          ${input.route.deliverySlotId}::uuid, ${input.effectiveDate}::date, ${input.createdBy}::uuid,
          now(), now())`);
      for (const [index, householdId] of input.householdIds.entries()) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO route_stops (id, vendor_id, route_id, plan_id, household_id, delivery_slot_id,
            sequence, effective_from, created_by, created_at, updated_at)
          VALUES (${randomUUID()}::uuid, ${input.route.vendorId}::uuid, ${input.route.id}::uuid,
            ${planId}::uuid, ${householdId}::uuid, ${input.route.deliverySlotId}::uuid,
            ${index + 1}, ${input.effectiveDate}::date, ${input.createdBy}::uuid, now(), now())`);
      }
      const route = await tx.route.update({ where: { id: input.route.id }, data: { version: { increment: 1 } },
        select: { id: true, vendorId: true, code: true, name: true, deliverySlotId: true, status: true, version: true, createdAt: true, updatedAt: true } });
      return { projection: await this.list(context, route, { serviceDate: input.effectiveDate }), previous };
    } catch (cause) {
      this.translate(cause);
      throw cause;
    }
  }

  async hasCurrentOrFutureStops(context: TransactionContext, routeId: string, today: string) {
    const rows = await unwrapPrismaTransaction(context).$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
      SELECT EXISTS (SELECT 1 FROM route_stops WHERE route_id=${routeId}::uuid
        AND superseded_at IS NULL AND (effective_to IS NULL OR effective_to > ${today}::date)) AS present`);
    return rows[0]?.present ?? false;
  }

  private translate(cause: unknown) {
    const details = this.details(cause);
    if (['route_stop_plans_no_period_overlap','route_stops_no_household_slot_overlap','route_stops_no_sequence_overlap'].some((name)=>details.includes(name)))
      throw error('ROUTE_STOP_CONFLICT', 'Route stop plan conflicts with another effective placement', 409);
  }

  private details(value: unknown, seen = new Set<unknown>()): string {
    if (value === null || value === undefined || seen.has(value)) return '';
    if (typeof value !== 'object') return typeof value === 'string' ? value : JSON.stringify(value) ?? '';
    seen.add(value);
    return Object.values(value as Record<string, unknown>).map((item) => this.details(item, seen)).join(' ');
  }
  private plans(context:TransactionContext,routeId:string,serviceDate:string) {
    return unwrapPrismaTransaction(context).$queryRaw<PlanRow[]>(Prisma.sql`
      SELECT id, effective_from::text AS "effectiveFrom", effective_to::text AS "effectiveTo"
      FROM route_stop_plans WHERE route_id=${routeId}::uuid AND superseded_at IS NULL
        AND effective_from <= ${serviceDate}::date AND (effective_to IS NULL OR effective_to > ${serviceDate}::date)
      ORDER BY effective_from DESC,id DESC LIMIT 1`);
  }
  private async snapshot(context:TransactionContext,route:RouteRecord,serviceDate:string) {
    const tx=unwrapPrismaTransaction(context),plan=(await this.plans(context,route.id,serviceDate))[0];
    const stops=plan?await tx.$queryRaw<StopRow[]>(Prisma.sql`SELECT id,household_id AS "householdId",sequence FROM route_stops WHERE plan_id=${plan.id}::uuid AND superseded_at IS NULL ORDER BY sequence,id`):[];
    return {routeId:route.id,routeVersion:route.version,deliverySlotId:route.deliverySlotId,serviceDate,...(plan?publicRouteStopPeriod(plan.effectiveFrom,plan.effectiveTo??undefined):{}),stops};
  }
  private limit(value?:number) {
    const limit=value??25;if(!Number.isInteger(limit)||limit<1||limit>100) throw error('INVALID_PAGINATION','Limit must be between 1 and 100',400);return limit;
  }
  private encode(value:StopCursor) { return Buffer.from(JSON.stringify([value.sequence,value.id])).toString('base64url'); }
  private decode(value:string):StopCursor {
    try { if(!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();const decoded=Buffer.from(value,'base64url');if(decoded.toString('base64url')!==value)throw new Error();const parsed:unknown=JSON.parse(decoded.toString('utf8'));if(!Array.isArray(parsed)||parsed.length!==2)throw new Error();const sequence:unknown=parsed[0],id:unknown=parsed[1];if(typeof sequence!=='number'||!Number.isInteger(sequence)||sequence<1||typeof id!=='string'||!uuid.test(id))throw new Error();return{sequence,id}; }
    catch { throw error('INVALID_CURSOR','Cursor is invalid',400); }
  }
}
