import { Injectable } from "@nestjs/common";

import { Prisma } from "../../generated/prisma/client.js";
import type { TransactionContext } from "../../common/application/transaction-context.js";
import { CursorCodec } from "../../common/cursor/cursor.js";
import { ApplicationError } from "../../common/errors/application.error.js";
import { unwrapPrismaTransaction } from "../../database/infrastructure/prisma-transaction-context.js";
import type {
  CreateHousehold,
  PageQuery,
  UpdateHousehold,
} from "../application/household.service.js";

export type HouseholdRecord = Readonly<{
  id: string;
  vendorId: string;
  accountNumber: string;
  name: string;
  addressLine1: string;
  addressLine2?: string;
  locality?: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  latitude?: string;
  longitude?: string;
  status: "active" | "inactive";
  notes?: string;
  version: number;
  deletedAt?: Date;
  deletedBy?: string;
  deletionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}>;
export type HouseholdMemberRecord = Readonly<{
  id: string;
  householdId: string;
  customerMembershipId: string;
  status: "active" | "ended";
  joinedAt: Date;
  endedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}>;

const householdSelect = {
  id: true,
  vendorId: true,
  accountNumber: true,
  name: true,
  addressLine1: true,
  addressLine2: true,
  locality: true,
  city: true,
  region: true,
  postalCode: true,
  countryCode: true,
  latitude: true,
  longitude: true,
  status: true,
  notes: true,
  version: true,
  deletedAt: true,
  deletedBy: true,
  deletionReason: true,
  createdAt: true,
  updatedAt: true,
} as const;
const memberSelect = {
  id: true,
  householdId: true,
  customerMembershipId: true,
  status: true,
  joinedAt: true,
  endedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;
type HouseholdRow = Prisma.HouseholdGetPayload<{
  select: typeof householdSelect;
}>;
type HouseholdMemberRow = Prisma.HouseholdMemberGetPayload<{
  select: typeof memberSelect;
}>;
const error = (code: string, message: string, status: number) =>
  new ApplicationError(code, message, status);

function toHousehold(row: HouseholdRow): HouseholdRecord {
  return {
    id: row.id,
    vendorId: row.vendorId,
    accountNumber: row.accountNumber,
    name: row.name,
    addressLine1: row.addressLine1,
    ...(row.addressLine2 ? { addressLine2: row.addressLine2 } : {}),
    ...(row.locality ? { locality: row.locality } : {}),
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    countryCode: row.countryCode,
    ...(row.latitude ? { latitude: row.latitude.toString() } : {}),
    ...(row.longitude ? { longitude: row.longitude.toString() } : {}),
    status: row.status,
    ...(row.notes ? { notes: row.notes } : {}),
    version: row.version,
    ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
    ...(row.deletedBy ? { deletedBy: row.deletedBy } : {}),
    ...(row.deletionReason ? { deletionReason: row.deletionReason } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function toMember(row: HouseholdMemberRow): HouseholdMemberRecord {
  return {
    id: row.id,
    householdId: row.householdId,
    customerMembershipId: row.customerMembershipId,
    status: row.status,
    joinedAt: row.joinedAt,
    ...(row.endedAt ? { endedAt: row.endedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class PrismaHouseholdStore {
  async requireRouteHouseholds(context: TransactionContext, householdIds: readonly string[]) {
    const ids = [...new Set(householdIds)].sort();
    if (ids.length === 0) return { householdIds: ids };
    const rows = await unwrapPrismaTransaction(context).$queryRaw<Array<{ id: string; status: string; deletedAt: Date | null }>>(
      Prisma.sql`SELECT id,status,deleted_at AS "deletedAt" FROM households WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`,
    );
    if (rows.length !== ids.length) throw error("ROUTE_HOUSEHOLD_NOT_FOUND", "Route household was not found", 404);
    if (rows.some(({ status, deletedAt }) => status !== "active" || deletedAt !== null))
      throw error("ROUTE_HOUSEHOLD_NOT_AVAILABLE", "Route household is not available", 409);
    return { householdIds: ids };
  }
  async requireSubscriptionHousehold(context: TransactionContext, householdId: string) {
    const row = await unwrapPrismaTransaction(context).household.findFirst({
      where: { id: householdId }, select: { id: true, status: true, deletedAt: true },
    });
    if (!row || row.deletedAt)
      throw error("SUBSCRIPTION_HOUSEHOLD_NOT_FOUND", "Subscription household was not found", 404);
    if (row.status !== "active")
      throw error("SUBSCRIPTION_HOUSEHOLD_NOT_AVAILABLE", "Subscription household is not available", 409);
    return { householdId: row.id };
  }

  async requireCustomerSubscriptionHousehold(context: TransactionContext, householdId: string, membershipIds: readonly string[]) {
    const member = await unwrapPrismaTransaction(context).householdMember.findFirst({
      where: { householdId, customerMembershipId: { in: [...membershipIds] }, status: "active" },
      select: { id: true },
    });
    if (!member) throw error("FORBIDDEN", "You are not allowed to perform this action", 403);
    return this.requireSubscriptionHousehold(context, householdId);
  }
  async requirePricingHousehold(context: TransactionContext, householdId: string) {
    const row = await unwrapPrismaTransaction(context).household.findFirst({
      where: { id: householdId }, select: { id: true, status: true, deletedAt: true },
    });
    if (!row || row.deletedAt) throw error("PRICE_HOUSEHOLD_NOT_FOUND", "Price household was not found", 404);
    if (row.status !== "active") throw error("PRICE_HOUSEHOLD_NOT_AVAILABLE", "Price household is not available", 409);
    return { householdId: row.id };
  }

  async requireCustomerPricingHousehold(context: TransactionContext, householdId: string, membershipIds: readonly string[]) {
    const member = await unwrapPrismaTransaction(context).householdMember.findFirst({
      where: { householdId, customerMembershipId: { in: [...membershipIds] }, status: "active" },
      select: { id: true },
    });
    if (!member) throw error("FORBIDDEN", "You are not allowed to perform this action", 403);
    await this.requirePricingHousehold(context, householdId);
    return { householdId };
  }
  private readonly cursors = new CursorCodec();
  async list(context: TransactionContext, query: PageQuery) {
    const tx = unwrapPrismaTransaction(context);
    const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await tx.household.findMany({
      where: {
        deletedAt: null,
        status: "active",
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: householdSelect,
    });
    return this.page(rows.map(toHousehold), limit);
  }
  async get(context: TransactionContext, id: string) {
    const row = await unwrapPrismaTransaction(context).household.findFirst({
      where: { id, deletedAt: null, status: "active" },
      select: householdSelect,
    });
    if (!row)
      throw error("HOUSEHOLD_NOT_FOUND", "Household was not found", 404);
    return toHousehold(row);
  }
  async create(
    context: TransactionContext,
    input: CreateHousehold & { id: string; vendorId: string },
  ) {
    try {
      const row = await unwrapPrismaTransaction(context).household.create({
        data: {
          ...input,
          latitude: input.latitude
            ? new Prisma.Decimal(input.latitude)
            : undefined,
          longitude: input.longitude
            ? new Prisma.Decimal(input.longitude)
            : undefined,
        },
        select: householdSelect,
      });
      return toHousehold(row);
    } catch (cause) {
      this.translate(cause);
      throw cause;
    }
  }
  async update(
    context: TransactionContext,
    id: string,
    version: number,
    input: UpdateHousehold,
  ) {
    const tx = unwrapPrismaTransaction(context);
    const { latitude, longitude } = input;
    const data = {
      accountNumber: input.accountNumber,
      name: input.name,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      locality: input.locality,
      city: input.city,
      region: input.region,
      postalCode: input.postalCode,
      countryCode: input.countryCode,
      status: input.status,
      notes: input.notes,
    };
    try {
      const changed = await tx.household.updateMany({
        where: { id, version, deletedAt: null },
        data: {
          ...data,
          latitude:
            latitude === undefined
              ? undefined
              : latitude === null
                ? null
                : new Prisma.Decimal(latitude),
          longitude:
            longitude === undefined
              ? undefined
              : longitude === null
                ? null
                : new Prisma.Decimal(longitude),
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw error(
          "HOUSEHOLD_VERSION_CONFLICT",
          "Household was changed by another request",
          409,
        );
      return this.getNonDeleted(context, id);
    } catch (cause) {
      this.translate(cause);
      throw cause;
    }
  }
  async softDelete(
    context: TransactionContext,
    id: string,
    version: number,
    actorId: string,
    deletionReason: string,
  ) {
    const tx = unwrapPrismaTransaction(context);
    const changed = await tx.household.updateMany({
      where: { id, version, deletedAt: null },
      data: {
        deletedAt: new Date(),
        deletedBy: actorId,
        deletionReason,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1)
      throw error(
        "HOUSEHOLD_VERSION_CONFLICT",
        "Household was changed by another request",
        409,
      );
    const row = await tx.household.findFirst({
      where: { id },
      select: householdSelect,
    });
    if (!row)
      throw error("HOUSEHOLD_NOT_FOUND", "Household was not found", 404);
    return toHousehold(row);
  }
  async restore(context: TransactionContext, id: string, version: number) {
    const tx = unwrapPrismaTransaction(context);
    try {
      const changed = await tx.household.updateMany({
        where: { id, version, deletedAt: { not: null } },
        data: {
          deletedAt: null,
          deletedBy: null,
          deletionReason: null,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw error(
          "HOUSEHOLD_VERSION_CONFLICT",
          "Household was changed by another request",
          409,
        );
      return this.getNonDeleted(context, id);
    } catch (cause) {
      this.translate(cause);
      throw cause;
    }
  }
  async listMembers(
    context: TransactionContext,
    householdId: string,
    query: PageQuery,
  ) {
    await this.get(context, householdId);
    const tx = unwrapPrismaTransaction(context);
    const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    const rows = await tx.householdMember.findMany({
      where: {
        householdId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: memberSelect,
    });
    return this.page(rows.map(toMember), limit);
  }
  async attach(
    context: TransactionContext,
    input: Readonly<{
      id: string;
      vendorId: string;
      householdId: string;
      customerMembershipId: string;
    }>,
  ) {
    try {
      const row = await unwrapPrismaTransaction(context).householdMember.create(
        { data: { ...input, joinedAt: new Date() }, select: memberSelect },
      );
      return toMember(row);
    } catch (cause) {
      this.translate(cause);
      throw cause;
    }
  }
  async endMember(
    context: TransactionContext,
    householdId: string,
    id: string,
  ) {
    const tx = unwrapPrismaTransaction(context);
    const changed = await tx.householdMember.updateMany({
      where: { id, householdId, status: "active" },
      data: { status: "ended", endedAt: new Date() },
    });
    if (changed.count !== 1)
      throw error(
        "HOUSEHOLD_MEMBER_STATE_CONFLICT",
        "Household member is not active",
        409,
      );
    const row = await tx.householdMember.findFirst({
      where: { id },
      select: memberSelect,
    });
    if (!row)
      throw error(
        "HOUSEHOLD_MEMBER_NOT_FOUND",
        "Household member was not found",
        404,
      );
    return toMember(row);
  }
  async listForCustomer(
    context: TransactionContext,
    membershipIds: readonly string[],
    query: PageQuery,
  ) {
    const tx = unwrapPrismaTransaction(context);
    const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor ? this.cursors.decode(query.cursor) : undefined;
    if (membershipIds.length === 0) return { items: [] };
    const rows = await tx.household.findMany({
      where: {
        deletedAt: null,
        status: "active",
        members: {
          some: {
            status: "active",
            customerMembershipId: { in: [...membershipIds] },
          },
        },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: householdSelect,
    });
    return this.page(rows.map(toHousehold), limit);
  }
  private page<T extends { createdAt: Date; id: string }>(
    rows: readonly T[],
    limit: number,
  ) {
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > limit && last
        ? {
            nextCursor: this.cursors.encode({
              createdAt: last.createdAt,
              id: last.id,
            }),
          }
        : {}),
    };
  }
  private async getNonDeleted(context: TransactionContext, id: string) {
    const row = await unwrapPrismaTransaction(context).household.findFirst({
      where: { id, deletedAt: null },
      select: householdSelect,
    });
    if (!row)
      throw error("HOUSEHOLD_NOT_FOUND", "Household was not found", 404);
    return toHousehold(row);
  }
  private translate(cause: unknown): void {
    if (typeof cause !== "object" || cause === null || !("code" in cause))
      return;
    if (cause.code === "P2002")
      throw error("HOUSEHOLD_CONFLICT", "Household already exists", 409);
    if (cause.code === "P2003")
      throw error("HOUSEHOLD_NOT_FOUND", "Household was not found", 404);
  }
}
