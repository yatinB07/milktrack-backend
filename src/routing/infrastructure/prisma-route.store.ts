import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { CursorCodec } from '../../common/cursor/cursor.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import { RouteStore, type RoutePageQuery, type RouteRecord, type RouteStatus } from '../application/route.store.js';

const select = { id: true, vendorId: true, code: true, name: true, deliverySlotId: true, status: true, version: true, createdAt: true, updatedAt: true } as const;
type Row = Prisma.RouteGetPayload<{ select: typeof select }>;
const error = (code: string, message: string, status: number) => new ApplicationError(code, message, status);

@Injectable()
export class PrismaRouteStore extends RouteStore {
  private readonly cursors = new CursorCodec();

  async list(context: TransactionContext, query: RoutePageQuery) {
    const tx = unwrapPrismaTransaction(context); const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await tx.route.findMany({ where: {
      deletedAt: null, status: query.status ?? 'active',
      ...(query.deliverySlotId ? { deliverySlotId: query.deliverySlotId } : {}),
      ...(query.search ? { OR: [{ code: { contains: query.search, mode: 'insensitive' } }, { name: { contains: query.search, mode: 'insensitive' } }] } : {}),
      ...(cursor ? { AND: [{ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] } : {}),
    }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, select });
    const items = rows.slice(0, limit).map(toRecord); const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { nextCursor: this.cursors.encode({ createdAt: last.createdAt, id: last.id }) } : {}) };
  }
  async get(context: TransactionContext, id: string) {
    const row = await unwrapPrismaTransaction(context).route.findFirst({ where: { id, deletedAt: null }, select });
    if (!row) throw error('ROUTE_NOT_FOUND', 'Route was not found', 404);
    return toRecord(row);
  }
  async create(context: TransactionContext, input: RouteRecord) {
    try { return toRecord(await unwrapPrismaTransaction(context).route.create({ data: input, select })); }
    catch (cause) { this.translate(cause); throw cause; }
  }
  async rename(context: TransactionContext, id: string, expectedVersion: number, name: string) {
    const before = await this.lockRoot(context, id, expectedVersion);
    const after = toRecord(await unwrapPrismaTransaction(context).route.update({ where: { id }, data: { name, version: { increment: 1 } }, select }));
    return { before, after };
  }
  async changeStatus(context: TransactionContext, id: string, expectedVersion: number, status: RouteStatus) {
    const before = await this.lockRoot(context, id, expectedVersion);
    if (before.status === status) throw error('ROUTE_STATE_CONFLICT', `Route is already ${status}`, 409);
    const after = toRecord(await unwrapPrismaTransaction(context).route.update({ where: { id }, data: { status, version: { increment: 1 } }, select }));
    return { before, after };
  }
  async softDelete(context: TransactionContext, id: string, expectedVersion: number, actorId: string, reason: string) {
    const before = await this.lockRoot(context, id, expectedVersion);
    if (before.status !== 'inactive') throw error('ROUTE_DELETE_REQUIRES_INACTIVE', 'Route must be inactive before deletion', 409);
    const after = toRecord(await unwrapPrismaTransaction(context).route.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: actorId, deletionReason: reason, version: { increment: 1 } }, select }));
    return { before, after };
  }
  async restore(context: TransactionContext, id: string, expectedVersion: number) {
    const before = await this.lockRoot(context, id, expectedVersion, true);
    try {
      const after = toRecord(await unwrapPrismaTransaction(context).route.update({ where: { id }, data: { status: 'inactive', deletedAt: null, deletedBy: null, deletionReason: null, version: { increment: 1 } }, select }));
      return { before, after };
    } catch (cause) { this.translate(cause); throw cause; }
  }
  async lockRoot(context: TransactionContext, id: string, expectedVersion: number, deleted = false) {
    const tx = unwrapPrismaTransaction(context);
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM routes WHERE id=${id}::uuid AND deleted_at IS ${deleted ? Prisma.sql`NOT NULL` : Prisma.sql`NULL`} FOR UPDATE`);
    if (!rows[0]) throw error('ROUTE_NOT_FOUND', 'Route was not found', 404);
    const row = await tx.route.findFirst({ where: { id }, select }); if (!row) throw error('ROUTE_NOT_FOUND', 'Route was not found', 404);
    const route = toRecord(row); this.expectVersion(route.version, expectedVersion); return route;
  }
  private expectVersion(actual: number, expected: number) { if (actual !== expected) throw error('ROUTE_VERSION_CONFLICT', 'Route was changed by another request', 409); }
  private translate(cause: unknown) {
    if (typeof cause !== 'object' || cause === null || !('code' in cause)) return;
    if (cause.code === 'P2002') throw error('ROUTE_CODE_CONFLICT', 'Route code already exists', 409);
    if (cause.code === 'P2003') throw error('ROUTE_SLOT_NOT_AVAILABLE', 'Delivery slot is not available', 409);
  }
}

const toRecord = (row: Row): RouteRecord => ({ ...row, status: row.status });
