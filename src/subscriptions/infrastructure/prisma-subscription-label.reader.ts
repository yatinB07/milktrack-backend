import { Injectable } from '@nestjs/common';

import type { TransactionContext } from '../../common/application/transaction-context.js';
import { unwrapPrismaTransaction } from '../../database/infrastructure/prisma-transaction-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  SubscriptionLabelReader,
  type SubscriptionLabelMatch,
  type SubscriptionLabelReference,
} from '../application/subscription-label.reader.js';

@Injectable()
export class PrismaSubscriptionLabelReader extends SubscriptionLabelReader {
  async read(
    context: TransactionContext,
    input: Readonly<{
      vendorId: string;
      householdId?: string;
      references: readonly SubscriptionLabelReference[];
    }>,
  ): Promise<readonly SubscriptionLabelMatch[]> {
    if (input.references.length === 0) return [];
    const references = Prisma.join(input.references.map((reference) => referenceRow(reference)));
    const rows = await unwrapPrismaTransaction(context).$queryRaw<SubscriptionLabelMatch[]>(Prisma.sql`
      WITH requested(kind,reference_id,subscription_id,start_date,end_date,service_date,delivery_slot_id) AS (
        VALUES ${references}
      )
      SELECT DISTINCT requested.reference_id AS "referenceId",s.id AS "subscriptionId",
        p.id AS "productId",p.name AS "productName",d.id AS "deliverySlotId",d.name AS "deliverySlotName"
      FROM requested
      JOIN subscriptions s ON s.id=requested.subscription_id
      JOIN subscription_revisions r ON r.vendor_id=s.vendor_id AND r.subscription_id=s.id
      JOIN products p ON p.vendor_id=r.vendor_id AND p.id=r.product_id
      JOIN delivery_slots d ON d.vendor_id=r.vendor_id AND d.id=r.delivery_slot_id
      WHERE s.vendor_id=${input.vendorId}::uuid AND s.deleted_at IS NULL
        ${input.householdId ? Prisma.sql`AND s.household_id=${input.householdId}::uuid` : Prisma.empty}
        AND (
          (requested.kind='range' AND daterange(r.effective_from,r.effective_to,'[)')
            && daterange(requested.start_date,requested.end_date + 1,'[)'))
          OR (requested.kind='occurrence' AND r.effective_from<=requested.service_date
            AND (r.effective_to IS NULL OR r.effective_to>requested.service_date)
            AND r.delivery_slot_id=requested.delivery_slot_id)
        )
      ORDER BY "referenceId","subscriptionId","productId","deliverySlotId"
    `);
    return rows.sort(compareLabels);
  }
}

function referenceRow(reference: SubscriptionLabelReference): Prisma.Sql {
  return reference.kind === 'range'
    ? Prisma.sql`('range',${reference.referenceId},${reference.subscriptionId}::uuid,${reference.startDate}::date,${reference.endDate}::date,NULL::date,NULL::uuid)`
    : Prisma.sql`('occurrence',${reference.referenceId},${reference.subscriptionId}::uuid,NULL::date,NULL::date,${reference.serviceDate}::date,${reference.deliverySlotId}::uuid)`;
}

function compareLabels(left: SubscriptionLabelMatch, right: SubscriptionLabelMatch): number {
  return left.referenceId.localeCompare(right.referenceId)
    || left.subscriptionId.localeCompare(right.subscriptionId)
    || left.productId.localeCompare(right.productId)
    || left.deliverySlotId.localeCompare(right.deliverySlotId);
}
