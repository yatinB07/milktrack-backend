import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../audit/application/audit-writer.js';
import { AuthorizationPolicy } from '../../authorization/application/authorization.policy.js';
import { TenantAuthorizationExecutor } from '../../authorization/application/tenant-authorization.executor.js';
import {
  type Actor,
  requestContextStore,
} from '../../common/context/request-context.js';
import { CursorCodec } from '../../common/cursor/cursor.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { TenantTransactionRunner, type TransactionContext } from '../../common/application/transaction-context.js';
import type { VendorStatus } from '../domain/vendor-lifecycle.js';
import type { DeliveryPolicy, UpdateDeliveryPolicyCommand } from '../domain/delivery-policy.js';
import { PrismaVendorStore } from '../infrastructure/prisma-vendor.store.js';
import { TransitionVendor } from './transition-vendor.js';

export type CreateVendorCommand = Readonly<{
  code: string;
  legalName: string;
  displayName: string;
  timezone: string;
  currency: string;
  skipCutoffMinutes: number;
  billingDay: number;
}>;

export type ListVendorsQuery = Readonly<{
  cursor?: string;
  limit?: number;
  status?: VendorStatus;
  search?: string;
}>;

export type TransitionVendorCommand = Readonly<{
  vendorId: string;
  to: VendorStatus;
  reason: string;
  expectedVersion: number;
}>;

export type VendorResult = Readonly<{
  id: string;
  code: string;
  legalName: string;
  displayName: string;
  status: VendorStatus;
  timezone: string;
  currency: string;
  skipCutoffMinutes: number;
  billingDay: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export abstract class VendorService {
  abstract getDeliveryPolicy(actor: Actor, vendorId: string): Promise<DeliveryPolicy>;
  abstract updateDeliveryPolicy(actor: Actor, vendorId: string, command: UpdateDeliveryPolicyCommand): Promise<DeliveryPolicy>;
  abstract getSubscriptionTimezone(tx: TransactionContext, vendorId: string): Promise<Readonly<{ timezone: string }>>;
  abstract getPricingSettings(tx: TransactionContext, vendorId: string): Promise<Readonly<{ timezone: string; currency: string }>>;
  abstract create(actor: Actor, command: CreateVendorCommand): Promise<VendorResult>;
  abstract list(
    actor: Actor,
    query: ListVendorsQuery,
  ): Promise<Readonly<{ items: readonly VendorResult[]; nextCursor?: string }>>;
  abstract get(actor: Actor, vendorId: string): Promise<VendorResult>;
  abstract getProfile(actor: Actor, vendorId: string): Promise<VendorResult>;
  abstract transition(
    actor: Actor,
    command: TransitionVendorCommand,
  ): Promise<VendorResult>;
}

@Injectable()
export class PrismaVendorService extends VendorService {
  private readonly cursors = new CursorCodec();

  constructor(
    @Inject(AuthorizationPolicy)
    private readonly authorization: AuthorizationPolicy,
    @Inject(TenantTransactionRunner)
    private readonly transactions: TenantTransactionRunner,
    @Inject(TenantAuthorizationExecutor)
    private readonly tenantAuthorization: TenantAuthorizationExecutor,
    @Inject(PrismaVendorStore)
    private readonly vendors: PrismaVendorStore,
    @Inject(AuditWriter)
    private readonly audits: AuditWriter,
    @Inject(TransitionVendor)
    private readonly lifecycle: TransitionVendor,
  ) {
    super();
  }

  getPricingSettings(tx: TransactionContext, vendorId: string) {
    return this.vendors.getPricingSettings(tx, vendorId);
  }

  getSubscriptionTimezone(tx: TransactionContext, vendorId: string) {
    return this.vendors.getSubscriptionTimezone(tx, vendorId);
  }

  getDeliveryPolicy(actor: Actor, vendorId: string): Promise<DeliveryPolicy> {
    return this.tenantAuthorization.execute({ actor, vendorId, permission: 'vendor:profile:read', operation: 'vendor.profile.read' }, (tx) => this.vendors.getDeliveryPolicy(tx, vendorId));
  }

  updateDeliveryPolicy(actor: Actor, vendorId: string, command: UpdateDeliveryPolicyCommand): Promise<DeliveryPolicy> {
    return this.tenantAuthorization.execute({ actor, vendorId, permission: 'vendor:profile:read', operation: 'vendor.profile.read' }, async (tx) => {
      const previous = await this.vendors.getDeliveryPolicy(tx, vendorId);
      const updated = await this.vendors.updateDeliveryPolicy(tx, vendorId, command);
      await this.audits.append(tx, {
        id: randomUUID(), vendorId, actorUserId: actor.userId, action: 'vendor.delivery_policy.updated', entityType: 'vendor', entityId: vendorId,
        oldValue: this.deliveryPolicyAuditValue(previous), newValue: this.deliveryPolicyAuditValue(updated), reason: command.reason, correlationId: requestContextStore.require().correlationId,
      });
      return updated;
    });
  }

  async create(actor: Actor, command: CreateVendorCommand): Promise<VendorResult> {
    this.authorization.requirePlatform(actor, 'vendor:create');
    this.requireIanaTimezone(command.timezone);
    const vendorId = randomUUID();
    return this.transactions.run(vendorId, async (tx) => {
      const vendor = await this.vendors.create(tx, vendorId, command);
      const context = requestContextStore.require();
      await this.audits.append(tx, {
        id: randomUUID(),
        vendorId,
        actorUserId: actor.userId,
        action: 'vendor.created',
        entityType: 'vendor',
        entityId: vendorId,
        newValue: { code: vendor.code, status: vendor.status },
        correlationId: context.correlationId,
        ipHash: context.ipHash,
        deviceId: context.deviceId,
      });
      return vendor;
    });
  }

  async list(
    actor: Actor,
    query: ListVendorsQuery,
  ): Promise<Readonly<{ items: readonly VendorResult[]; nextCursor?: string }>> {
    this.authorization.requirePlatform(actor, 'vendor:read');
    const limit = this.cursors.parseLimit(query.limit);
    const cursor = query.cursor === undefined ? undefined : this.cursors.decode(query.cursor);
    const search = query.search?.trim();
    const page = await this.vendors.listActive({
      limit,
      cursor,
      status: query.status,
      search: search || undefined,
    });
    return {
      items: page.items,
      ...(page.next === undefined ? {} : { nextCursor: this.cursors.encode(page.next) }),
    };
  }

  get(actor: Actor, vendorId: string): Promise<VendorResult> {
    this.authorization.requirePlatform(actor, 'vendor:read');
    return this.vendors.getActive(vendorId);
  }

  getProfile(actor: Actor, vendorId: string): Promise<VendorResult> {
    return this.tenantAuthorization.execute(
      {
        actor,
        vendorId,
        permission: 'vendor:profile:read',
        operation: 'vendor.profile.read',
      },
      (tx) => this.vendors.findActive(tx, vendorId),
    );
  }

  transition(actor: Actor, command: TransitionVendorCommand): Promise<VendorResult> {
    this.authorization.requirePlatform(actor, 'vendor:transition');
    return this.lifecycle.execute(command, actor);
  }

  private requireIanaTimezone(timezone: string): void {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    } catch {
      throw new ApplicationError(
        'INVALID_TIMEZONE',
        'Timezone must be a valid IANA timezone',
        400,
      );
    }
  }

  private deliveryPolicyAuditValue(policy: DeliveryPolicy) {
    return { skipCutoffMinutes: policy.skipCutoffMinutes, lateLeavePolicy: policy.lateLeavePolicy, captureAgentLocationEvidence: policy.captureAgentLocationEvidence, version: policy.version };
  }
}
