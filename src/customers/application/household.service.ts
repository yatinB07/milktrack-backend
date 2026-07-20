import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { AuditWriter } from "../../audit/application/audit-writer.js";
import { TenantAuthorizationExecutor } from "../../authorization/application/tenant-authorization.executor.js";
import type { Actor } from "../../common/context/request-context.js";
import { requestContextStore } from "../../common/context/request-context.js";
import type { TransactionContext } from "../../common/application/transaction-context.js";
import { ApplicationError } from "../../common/errors/application.error.js";
import {
  type CustomerMembershipSummary,
  MembershipService,
} from "../../memberships/application/membership.service.js";
import {
  PrismaHouseholdStore,
  type HouseholdRecord,
  type HouseholdMemberRecord,
} from "../infrastructure/prisma-household.store.js";

export type PageQuery = Readonly<{ cursor?: string; limit?: number }>;
export type HouseholdAddress = Readonly<{
  addressLine1: string;
  addressLine2?: string;
  locality?: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  latitude?: string;
  longitude?: string;
}>;
export type CreateHousehold = HouseholdAddress &
  Readonly<{ accountNumber: string; name: string; notes?: string }>;
export type UpdateHousehold = Readonly<{
  expectedVersion: number;
  accountNumber?: string;
  name?: string;
  addressLine1?: string;
  addressLine2?: string | null;
  locality?: string | null;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
  latitude?: string | null;
  longitude?: string | null;
  status?: "active" | "inactive";
  notes?: string | null;
}>;
export type VersionedReason = Readonly<{
  expectedVersion: number;
  reason: string;
}>;
export type HouseholdResult = Omit<
  HouseholdRecord,
  "deletedAt" | "deletedBy" | "deletionReason"
>;
export type HouseholdMemberResult = HouseholdMemberRecord &
  Readonly<{ userId: string; displayName?: string; phone?: string }>;
export type HouseholdPage = Readonly<{
  items: readonly HouseholdResult[];
  nextCursor?: string;
}>;
export type HouseholdMemberPage = Readonly<{
  items: readonly HouseholdMemberResult[];
  nextCursor?: string;
}>;
export abstract class HouseholdService {
  abstract requireSubscriptionHousehold(tx: TransactionContext, householdId: string): Promise<Readonly<{ householdId: string }>>;
  abstract requireCustomerSubscriptionHousehold(tx: TransactionContext, actor: Actor, vendorId: string, householdId: string): Promise<Readonly<{ householdId: string }>>;
  abstract requirePricingHousehold(tx: TransactionContext, householdId: string): Promise<Readonly<{ householdId: string }>>;
  abstract requireCustomerPricingHousehold(tx: TransactionContext, actor: Actor, vendorId: string, householdId: string): Promise<Readonly<{ householdId: string }>>;
  abstract list(
    actor: Actor,
    vendorId: string,
    query: PageQuery,
  ): Promise<HouseholdPage>;
  abstract get(
    actor: Actor,
    vendorId: string,
    householdId: string,
  ): Promise<HouseholdResult>;
  abstract create(
    actor: Actor,
    vendorId: string,
    command: CreateHousehold,
  ): Promise<HouseholdResult>;
  abstract update(
    actor: Actor,
    vendorId: string,
    householdId: string,
    command: UpdateHousehold,
  ): Promise<HouseholdResult>;
  abstract softDelete(
    actor: Actor,
    vendorId: string,
    householdId: string,
    command: VersionedReason,
  ): Promise<void>;
  abstract restore(
    actor: Actor,
    vendorId: string,
    householdId: string,
    command: VersionedReason,
  ): Promise<HouseholdResult>;
  abstract listMembers(
    actor: Actor,
    vendorId: string,
    householdId: string,
    query: PageQuery,
  ): Promise<HouseholdMemberPage>;
  abstract attachMember(
    actor: Actor,
    vendorId: string,
    householdId: string,
    customerMembershipId: string,
  ): Promise<HouseholdMemberResult>;
  abstract endMember(
    actor: Actor,
    vendorId: string,
    householdId: string,
    memberId: string,
    reason: string,
  ): Promise<HouseholdMemberResult>;
  abstract listForCustomer(
    actor: Actor,
    vendorId: string,
    query: PageQuery,
  ): Promise<HouseholdPage>;
}
const trim = (value: string) => value.trim();
function reason(value: string) {
  const result = trim(value);
  if (result.length < 3 || result.length > 500)
    throw new ApplicationError(
      "INVALID_REASON",
      "Reason must be between 3 and 500 characters",
      400,
    );
  return result;
}
function coordinates(input: {
  latitude?: string | null;
  longitude?: string | null;
}) {
  if ((input.latitude == null) !== (input.longitude == null))
    throw new ApplicationError(
      "INVALID_COORDINATES",
      "Latitude and longitude must be provided together",
      400,
    );
  if (
    input.latitude != null &&
    (Number(input.latitude) < -90 ||
      Number(input.latitude) > 90 ||
      Number(input.longitude) < -180 ||
      Number(input.longitude) > 180)
  )
    throw new ApplicationError(
      "INVALID_COORDINATES",
      "Coordinates are out of range",
      400,
    );
}
@Injectable()
export class PrismaHouseholdService extends HouseholdService {
  constructor(
    @Inject(TenantAuthorizationExecutor)
    private readonly authorization: TenantAuthorizationExecutor,
    @Inject(PrismaHouseholdStore)
    private readonly households: PrismaHouseholdStore,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(AuditWriter) private readonly audits: AuditWriter,
  ) {
    super();
  }
  requireSubscriptionHousehold(tx: TransactionContext, householdId: string) {
    return this.households.requireSubscriptionHousehold(tx, householdId);
  }
  async requireCustomerSubscriptionHousehold(tx: TransactionContext, actor: Actor, vendorId: string, householdId: string) {
    const membershipIds = actor.memberships
      .filter(({ vendorId: currentVendorId, role, status }) => currentVendorId === vendorId && role === "customer" && status === "active")
      .map(({ id }) => id);
    if (membershipIds.length !== 1)
      throw new ApplicationError("FORBIDDEN", "You are not allowed to perform this action", 403);
    try {
      await this.memberships.requireActiveCustomerMembership(tx, vendorId, membershipIds[0]);
    } catch (cause) {
      if (!(cause instanceof ApplicationError)) throw cause;
      throw new ApplicationError("FORBIDDEN", "You are not allowed to perform this action", 403);
    }
    return this.households.requireCustomerSubscriptionHousehold(tx, householdId, membershipIds);
  }
  requirePricingHousehold(tx: TransactionContext, householdId: string) {
    return this.households.requirePricingHousehold(tx, householdId);
  }
  async requireCustomerPricingHousehold(tx: TransactionContext, actor: Actor, vendorId: string, householdId: string) {
    const membershipIds = actor.memberships
      .filter(({ vendorId: currentVendorId, role, status }) => currentVendorId === vendorId && role === "customer" && status === "active")
      .map(({ id }) => id);
    if (membershipIds.length !== 1)
      throw new ApplicationError("FORBIDDEN", "You are not allowed to perform this action", 403);
    try {
      await this.memberships.requireActiveCustomerMembership(tx, vendorId, membershipIds[0]);
    } catch (cause) {
      if (!(cause instanceof ApplicationError)) throw cause;
      throw new ApplicationError("FORBIDDEN", "You are not allowed to perform this action", 403);
    }
    return this.households.requireCustomerPricingHousehold(tx, householdId, membershipIds);
  }
  list(actor: Actor, vendorId: string, query: PageQuery) {
    return this.authorize(
      actor,
      vendorId,
      "household:read",
      "household.list",
      async (tx) => this.households.list(tx, query),
    );
  }
  get(actor: Actor, vendorId: string, id: string) {
    return this.authorize(
      actor,
      vendorId,
      "household:read",
      "household.get",
      (tx) => this.households.get(tx, id),
    );
  }
  async create(actor: Actor, vendorId: string, command: CreateHousehold) {
    coordinates(command);
    return this.authorize(
      actor,
      vendorId,
      "household:manage",
      "household.create",
      async (tx) => {
        const created = await this.households.create(tx, {
          ...this.normalize(command),
          id: randomUUID(),
          vendorId,
        });
        await this.audit(
          tx,
          actor,
          vendorId,
          created.id,
          "household.created",
          "household",
          { status: created.status, version: created.version },
        );
        return created;
      },
    );
  }
  async update(
    actor: Actor,
    vendorId: string,
    id: string,
    command: UpdateHousehold,
  ) {
    const changedFields = Object.keys(command).filter(
      (key) =>
        key !== "expectedVersion" &&
        command[key as keyof UpdateHousehold] !== undefined,
    );
    if (changedFields.length === 0)
      throw new ApplicationError(
        "EMPTY_UPDATE",
        "At least one field must be updated",
        400,
      );
    coordinates(command);
    return this.authorize(
      actor,
      vendorId,
      "household:manage",
      "household.update",
      async (tx) => {
        const updated = await this.households.update(
          tx,
          id,
          command.expectedVersion,
          this.normalize(command),
        );
        await this.audit(
          tx,
          actor,
          vendorId,
          id,
          "household.updated",
          "household",
          {
            status: updated.status,
            version: updated.version,
            changedFields,
          },
        );
        return updated;
      },
    );
  }
  async softDelete(
    actor: Actor,
    vendorId: string,
    id: string,
    command: VersionedReason,
  ) {
    const value = reason(command.reason);
    await this.authorize(
      actor,
      vendorId,
      "household:manage",
      "household.delete",
      async (tx) => {
        const deleted = await this.households.softDelete(
          tx,
          id,
          command.expectedVersion,
          actor.userId,
          value,
        );
        await this.audit(
          tx,
          actor,
          vendorId,
          id,
          "household.deleted",
          "household",
          { status: deleted.status, version: deleted.version },
          value,
        );
      },
    );
  }
  async restore(
    actor: Actor,
    vendorId: string,
    id: string,
    command: VersionedReason,
  ) {
    const value = reason(command.reason);
    return this.authorize(
      actor,
      vendorId,
      "household:manage",
      "household.restore",
      async (tx) => {
        const restored = await this.households.restore(
          tx,
          id,
          command.expectedVersion,
        );
        await this.audit(
          tx,
          actor,
          vendorId,
          id,
          "household.restored",
          "household",
          { status: restored.status, version: restored.version },
          value,
        );
        return restored;
      },
    );
  }
  async listMembers(
    actor: Actor,
    vendorId: string,
    householdId: string,
    query: PageQuery,
  ) {
    return this.authorize(
      actor,
      vendorId,
      "household:read",
      "household.member-list",
      async (tx) =>
        this.enrichPage(
          tx,
          vendorId,
          await this.households.listMembers(tx, householdId, query),
        ),
    );
  }
  async attachMember(
    actor: Actor,
    vendorId: string,
    householdId: string,
    customerMembershipId: string,
  ) {
    return this.authorize(
      actor,
      vendorId,
      "household:manage",
      "household.member-attach",
      async (tx) => {
        await this.households.get(tx, householdId);
        const customer = await this.memberships.requireActiveCustomerMembership(
          tx,
          vendorId,
          customerMembershipId,
        );
        const member = await this.households.attach(tx, {
          id: randomUUID(),
          vendorId,
          householdId,
          customerMembershipId: customer.membershipId,
        });
        await this.audit(
          tx,
          actor,
          vendorId,
          member.id,
          "household.member_attached",
          "household_member",
          { status: member.status },
        );
        return this.enrichMember(tx, vendorId, member);
      },
    );
  }
  async endMember(
    actor: Actor,
    vendorId: string,
    householdId: string,
    memberId: string,
    input: string,
  ) {
    const value = reason(input);
    return this.authorize(
      actor,
      vendorId,
      "household:manage",
      "household.member-end",
      async (tx) => {
        const member = await this.households.endMember(
          tx,
          householdId,
          memberId,
        );
        await this.audit(
          tx,
          actor,
          vendorId,
          memberId,
          "household.member_ended",
          "household_member",
          { status: member.status },
          value,
        );
        return this.enrichMember(tx, vendorId, member);
      },
    );
  }
  listForCustomer(actor: Actor, vendorId: string, query: PageQuery) {
    const membershipIds = actor.memberships
      .filter(
        (membership) =>
          membership.vendorId === vendorId &&
          membership.role === "customer" &&
          membership.status === "active",
      )
      .map((membership) => membership.id);
    return this.authorize(
      actor,
      vendorId,
      "customer:self",
      "household.self-list",
      (tx) => this.households.listForCustomer(tx, membershipIds, query),
    );
  }
  private authorize<T>(
    actor: Actor,
    vendorId: string,
    permission: "household:read" | "household:manage" | "customer:self",
    operation: string,
    work: (tx: TransactionContext) => Promise<T>,
  ) {
    return this.authorization.execute(
      { actor, vendorId, permission, operation },
      work,
    );
  }
  private async enrichPage(
    tx: TransactionContext,
    vendorId: string,
    page: Readonly<{
      items: readonly HouseholdMemberRecord[];
      nextCursor?: string;
    }>,
  ): Promise<HouseholdMemberPage> {
    return {
      items: await Promise.all(
        page.items.map((member) => this.enrichMember(tx, vendorId, member)),
      ),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
  private async enrichMember(
    tx: TransactionContext,
    vendorId: string,
    member: HouseholdMemberRecord,
  ): Promise<HouseholdMemberResult> {
    const [customer] = await this.memberships.customerMembershipHistory(
      tx,
      vendorId,
      [member.customerMembershipId],
    );
    if (!customer)
      throw new ApplicationError(
        "HOUSEHOLD_MEMBER_NOT_FOUND",
        "Household member was not found",
        404,
      );
    return this.withCustomer(member, customer);
  }
  private withCustomer(
    member: HouseholdMemberRecord,
    customer: CustomerMembershipSummary,
  ): HouseholdMemberResult {
    return {
      ...member,
      userId: customer.userId,
      ...(customer.displayName ? { displayName: customer.displayName } : {}),
      ...(customer.phone ? { phone: customer.phone } : {}),
    };
  }
  private normalize<T extends Record<string, unknown>>(input: T): T {
    const output = { ...input } as Record<string, unknown>;
    for (const key of [
      "accountNumber",
      "name",
      "addressLine1",
      "addressLine2",
      "locality",
      "city",
      "region",
      "postalCode",
      "countryCode",
      "notes",
    ]) {
      if (typeof output[key] !== "string") continue;
      output[key] = trim(output[key]);
      if (output[key] === "") {
        throw new ApplicationError(
          "INVALID_HOUSEHOLD_FIELD",
          "Household text fields cannot be blank",
          400,
        );
      }
    }
    if (typeof output.accountNumber === "string")
      output.accountNumber = output.accountNumber.toUpperCase();
    if (typeof output.countryCode === "string")
      output.countryCode = output.countryCode.toUpperCase();
    return output as T;
  }
  private audit(
    tx: TransactionContext,
    actor: Actor,
    vendorId: string,
    id: string,
    action: string,
    entityType: string,
    newValue: unknown,
    reason?: string,
  ) {
    const context = requestContextStore.get();
    return this.audits.append(tx, {
      id: randomUUID(),
      vendorId,
      actorUserId: actor.userId,
      action,
      entityType,
      entityId: id,
      newValue,
      ...(reason ? { reason } : {}),
      correlationId: context?.correlationId ?? randomUUID(),
    });
  }
}
