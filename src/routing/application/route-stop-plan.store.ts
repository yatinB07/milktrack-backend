import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { RouteRecord } from './route.store.js';

export type RouteStopPlanRoute = Omit<RouteRecord, 'deletedAt'>;

export type RouteStopRecord = Readonly<{ id: string; householdId: string; sequence: number }>;
export type RouteStopProjection = Readonly<{
  routeId: string;
  routeVersion: number;
  deliverySlotId: string;
  serviceDate: string;
  startDate?: string;
  endDate?: string;
  stops: readonly RouteStopRecord[];
  nextCursor?: string;
}>;
export type RouteStopPageQuery = Readonly<{ serviceDate: string; cursor?: string; limit?: number }>;
export type RouteStopSnapshot = Omit<RouteStopProjection, 'nextCursor'>;
export type ReplaceRouteStopsInput = Readonly<{
  route: RouteStopPlanRoute;
  effectiveDate: string;
  householdIds: readonly string[];
  reason: string;
  createdBy: string;
}>;

export abstract class RouteStopPlanStore {
  abstract list(context: TransactionContext, route: RouteStopPlanRoute, query: RouteStopPageQuery): Promise<RouteStopProjection>;
  abstract replace(context: TransactionContext, input: ReplaceRouteStopsInput): Promise<Readonly<{ projection: RouteStopProjection; previous: RouteStopSnapshot }>>;
  abstract hasCurrentOrFutureStops(context: TransactionContext, routeId: string, today: string): Promise<boolean>;
}
