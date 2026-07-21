import type { TransactionContext } from '../../common/application/transaction-context.js';
import type { RouteRecord } from './route.store.js';

export type RouteAssignmentStatus = 'assigned' | 'cancelled';
export type RouteAssignmentRecord = Readonly<{
  id: string;
  routeId: string;
  deliverySlotId: string;
  agentMembershipId: string;
  serviceDate: string;
  status: RouteAssignmentStatus;
  createdAt: Date;
  updatedAt: Date;
}>;
export type RouteAssignmentPageQuery = Readonly<{
  cursor?: string;
  limit?: number;
  fromDate?: string;
  toDate?: string;
  status?: RouteAssignmentStatus;
}>;
export type RouteAssignmentPage = Readonly<{ items: readonly RouteAssignmentRecord[]; nextCursor?: string }>;
export type RouteAssignmentMutation = Readonly<{
  assignment: RouteAssignmentRecord;
  routeVersion: number;
  created: boolean;
  previous?: RouteAssignmentRecord;
}>;
export type RouteScheduleProjection = Readonly<{
  routeId: string;
  routeVersion: number;
  deliverySlotId: string;
  stops: readonly Readonly<{ stopId: string; householdId: string; sequence: number }>[];
  assignment?: Readonly<{ assignmentId: string; agentMembershipId: string }>;
}>;

export abstract class RouteAssignmentStore {
  abstract list(tx: TransactionContext, route: RouteRecord, query: RouteAssignmentPageQuery): Promise<RouteAssignmentPage>;
  abstract listSelf(
    tx: TransactionContext,
    agentMembershipId: string,
    serviceDate: string,
    query: Readonly<{ cursor?: string; limit?: number }>,
  ): Promise<RouteAssignmentPage>;
  abstract assign(
    tx: TransactionContext,
    input: Readonly<{ route: RouteRecord; serviceDate: string; agentMembershipId: string; actorId: string }>,
  ): Promise<RouteAssignmentMutation>;
  abstract cancel(tx: TransactionContext, input: Readonly<{ route: RouteRecord; serviceDate: string; actorId: string; reason: string }>): Promise<RouteAssignmentMutation>;
  abstract hasAssignedOnOrAfter(tx: TransactionContext, routeId: string, today: string): Promise<boolean>;
  abstract schedule(
    tx: TransactionContext,
    vendorId: string,
    serviceDate: string,
  ): Promise<readonly RouteScheduleProjection[]>;
  abstract projectRoute(
    tx: TransactionContext,
    vendorId: string,
    routeId: string,
    serviceDate: string,
  ): Promise<RouteScheduleProjection | undefined>;
}
