import { Inject, Injectable } from '@nestjs/common';

import type { Actor } from '../../common/context/request-context.js';
import { requestContextStore } from '../../common/context/request-context.js';
import {
  TenantTransactionRunner,
  type TransactionContext,
} from '../../common/application/transaction-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import {
  AuthorizationPolicy,
  requireSupportOperation,
  type VendorPermission,
} from './authorization.policy.js';
import { PrismaSecurityDenialRecorder } from '../infrastructure/security-denial.recorder.js';

export type TenantAuthorizationInput = Readonly<{
  actor: Actor;
  vendorId: string;
  permission: VendorPermission;
  operation: string;
}>;

export abstract class TenantAuthorizationExecutor {
  abstract execute<T>(
    input: TenantAuthorizationInput,
    operation: (tx: TransactionContext) => Promise<T>,
  ): Promise<T>;
}

@Injectable()
export class PrismaTenantAuthorizationExecutor extends TenantAuthorizationExecutor {
  constructor(
    @Inject(TenantTransactionRunner)
    private readonly transactions: TenantTransactionRunner,
    @Inject(AuthorizationPolicy)
    private readonly policy: AuthorizationPolicy,
    @Inject(PrismaSecurityDenialRecorder)
    private readonly denials: PrismaSecurityDenialRecorder,
  ) {
    super();
  }

  async execute<T>(
    input: TenantAuthorizationInput,
    operation: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.transactions.run(input.vendorId, async (tx) => {
        try {
          await this.policy.requireVendor(
            tx,
            input.actor,
            input.vendorId,
            input.permission,
            input.operation,
          );
        } catch (error) {
          if (
            !(error instanceof ApplicationError) ||
            error.code !== 'FORBIDDEN' ||
            !input.actor.platformRoles.includes('support_operations')
          ) {
            throw error;
          }
          requireSupportOperation(input.operation, input.permission);
          await this.policy.requireSupport(
            tx,
            input.actor,
            input.vendorId,
            input.permission,
            new Date(),
          );
        }
        return operation(tx);
      });
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.code !== 'FORBIDDEN') {
        throw error;
      }

      try {
        await this.denials.record({
          actorUserId: input.actor.userId,
          vendorId: input.vendorId,
          operation: input.operation,
          reasonCode: error.code,
          correlationId: requestContextStore.require().correlationId,
        });
      } catch {
        throw new ApplicationError(
          'SECURITY_AUDIT_UNAVAILABLE',
          'Security audit is temporarily unavailable',
          503,
          true,
        );
      }
      throw error;
    }
  }
}
