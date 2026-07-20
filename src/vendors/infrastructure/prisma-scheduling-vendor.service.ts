import { Inject, Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { CursorCodec } from '../../common/cursor/cursor.js';
import { PrismaService } from '../../database/infrastructure/prisma.service.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import {
  type SchedulableVendorPage,
  SchedulingVendorService,
} from '../application/scheduling-vendor.service.js';

@Injectable()
export class PrismaSchedulingVendorService extends SchedulingVendorService {
  private readonly cursors = new CursorCodec();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async listEligible(
    input: Readonly<{ cursor?: string; limit: number }>,
  ): Promise<SchedulableVendorPage> {
    const limit = this.cursors.parseLimit(input.limit);
    const cursor = input.cursor === undefined
      ? undefined
      : this.cursors.decode(input.cursor);
    const rows = await this.prisma.vendor.findMany({
      where: {
        status: { in: ['trial', 'active'] },
        deletedAt: null,
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }),
      },
      select: { id: true, timezone: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(({ id, timezone }) => ({ id, timezone })),
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: this.cursors.encode(last) }
        : {}),
    };
  }

  async findEligible(
    transaction: TransactionContext,
    vendorId: string,
  ) {
    const vendors = await unwrapPrismaTransaction(transaction)
      .$queryRaw<Array<{ id: string; timezone: string }>>`
        SELECT id, timezone
        FROM vendors
        WHERE id = ${vendorId}::uuid
          AND id = NULLIF(current_setting('app.vendor_id', true), '')::uuid
          AND status IN ('trial', 'active')
          AND deleted_at IS NULL
        LIMIT 1`;
    return vendors[0] ?? null;
  }
}
