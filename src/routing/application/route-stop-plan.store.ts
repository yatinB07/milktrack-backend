import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { RouteRecord } from './route.store.js';

export type RouteStopRecord = Readonly<{ id: string; householdId: string; sequence: number }>;
export type RouteStopProjection = Readonly<{
  routeId: string;
  routeVersion: number;
  deliverySlotId: string;
  serviceDate: string;
  startDate?: string;
  endDate?: string;
  stops: readonly RouteStopRecord[];
}>;
export type ReplaceRouteStopsInput = Readonly<{
  route: RouteRecord;
  effectiveDate: string;
  householdIds: readonly string[];
  reason: string;
  createdBy: string;
}>;

export abstract class RouteStopPlanStore {
  abstract list(context: TransactionContext, route: RouteRecord, serviceDate: string): Promise<RouteStopProjection>;
  abstract replace(context: TransactionContext, input: ReplaceRouteStopsInput): Promise<RouteStopProjection>;
  abstract hasCurrentOrFutureStops(context: TransactionContext, routeId: string, today: string): Promise<boolean>;
}
