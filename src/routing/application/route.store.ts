import type { TransactionContext } from '../../common/application/transaction-context.js';

export type RouteStatus = 'active' | 'inactive';
export type RouteRecord = Readonly<{
  id: string; vendorId: string; code: string; name: string; deliverySlotId: string;
  status: RouteStatus; version: number; createdAt: Date; updatedAt: Date;
}>;
export type RoutePageQuery = Readonly<{ cursor?: string; limit?: number; status?: RouteStatus; deliverySlotId?: string; search?: string }>;
export type RoutePage = Readonly<{ items: readonly RouteRecord[]; nextCursor?: string }>;
export type RouteChange = Readonly<{ before: RouteRecord; after: RouteRecord }>;

/** Persistence boundary for the route root; retained plans and assignments are separate work units. */
export abstract class RouteStore {
  abstract list(tx: TransactionContext, query: RoutePageQuery): Promise<RoutePage>;
  abstract get(tx: TransactionContext, id: string): Promise<RouteRecord>;
  abstract create(tx: TransactionContext, input: RouteRecord): Promise<RouteRecord>;
  abstract lockRoot(tx: TransactionContext, id: string, expectedVersion: number, includeDeleted?: boolean): Promise<RouteRecord>;
  abstract rename(tx: TransactionContext, id: string, expectedVersion: number, name: string): Promise<RouteChange>;
  abstract changeStatus(tx: TransactionContext, id: string, expectedVersion: number, status: RouteStatus): Promise<RouteChange>;
  abstract softDelete(tx: TransactionContext, id: string, expectedVersion: number, actorId: string, reason: string): Promise<RouteChange>;
  abstract restore(tx: TransactionContext, id: string, expectedVersion: number): Promise<RouteChange>;
}
