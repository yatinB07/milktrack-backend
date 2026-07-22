import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import type { SubscriptionLabelMatch } from '../src/subscriptions/application/subscription-label.reader.js';
import { PrismaSubscriptionLabelReader } from '../src/subscriptions/infrastructure/prisma-subscription-label.reader.js';

const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const reader = new PrismaSubscriptionLabelReader();
test.after(() => Promise.all([prisma.$disconnect(), owner.end()]));

type Fixture = Readonly<{
  userId: string;
  vendorId: string;
  otherVendorId: string;
  householdId: string;
  otherHouseholdId: string;
  subscriptionIds: readonly string[];
  productIds: readonly string[];
  slotIds: readonly string[];
}>;

async function fixture(): Promise<Fixture> {
  const userId = randomUUID();
  const vendorId = randomUUID();
  const otherVendorId = randomUUID();
  const householdId = randomUUID();
  const otherHouseholdId = randomUUID();
  const otherVendorHouseholdId = randomUUID();
  const unitIds = [randomUUID(), randomUUID()];
  const otherUnitId = randomUUID();
  const productIds = [randomUUID(), randomUUID(), randomUUID()];
  const otherProductId = randomUUID();
  const slotIds = [randomUUID(), randomUUID(), randomUUID()];
  const otherSlotId = randomUUID();
  const subscriptionIds = Array.from({ length: 5 }, randomUUID);

  await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [userId, 'Label fixture actor']);
  for (const [id, code] of [[vendorId, 'LABEL'], [otherVendorId, 'FOREIGN']] as const) {
    await owner.query(
      `INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at)
       VALUES($1,$2,$2,$2,'active','Asia/Kolkata','INR',0,1,now())`,
      [id, `${code}-${id.slice(0, 8)}`],
    );
  }
  for (const [id, account, selectedVendor] of [
    [householdId, 'VISIBLE', vendorId],
    [otherHouseholdId, 'OTHER-HOUSEHOLD', vendorId],
    [otherVendorHouseholdId, 'FOREIGN-VENDOR', otherVendorId],
  ] as const) {
    await owner.query(
      `INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at)
       VALUES($1,$2,$3,$3,'Road','Pune','MH','411001','IN',now())`,
      [id, selectedVendor, `${account}-${id.slice(0, 8)}`],
    );
  }
  for (const [index, id] of unitIds.entries()) {
    await owner.query('INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,$3,$4,3,now())', [id, vendorId, `UNIT-${index}`, `Unit ${index}`]);
  }
  await owner.query('INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,$3,$4,3,now())', [otherUnitId, otherVendorId, 'FOREIGN-UNIT', 'Foreign unit']);
  for (const [index, id] of productIds.entries()) {
    await owner.query('INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [id, vendorId, `PRODUCT-${index}`, `Product ${index}`, unitIds[index % unitIds.length]]);
  }
  await owner.query('INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [otherProductId, otherVendorId, 'FOREIGN-PRODUCT', 'Foreign product', otherUnitId]);
  for (const [index, id] of slotIds.entries()) {
    await owner.query(
      `INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at)
       VALUES($1,$2,$3,$4,'06:00','09:00',now())`,
      [id, vendorId, `SLOT-${index}`, `Slot ${index}`],
    );
  }
  await owner.query(
    `INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at)
     VALUES($1,$2,'FOREIGN-SLOT','Foreign slot','06:00','09:00',now())`,
    [otherSlotId, otherVendorId],
  );
  for (const [index, id] of subscriptionIds.entries()) {
    const selectedVendor = index === 4 ? otherVendorId : vendorId;
    const selectedHousehold = index === 4 ? otherVendorHouseholdId : index === 3 ? otherHouseholdId : householdId;
    await owner.query(
      `INSERT INTO subscriptions(id,vendor_id,household_id,deleted_at,deleted_by,deletion_reason,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,now())`,
      [id, selectedVendor, selectedHousehold, index === 2 ? new Date() : null, index === 2 ? userId : null, index === 2 ? 'Fixture deletion' : null],
    );
  }

  const revisions = [
    [subscriptionIds[0], productIds[0], slotIds[0], '2030-01-01', '2030-01-15', vendorId],
    [subscriptionIds[0], productIds[1], slotIds[1], '2030-01-15', '2030-02-01', vendorId],
    [subscriptionIds[1], productIds[2], slotIds[2], '2030-01-01', null, vendorId],
    [subscriptionIds[2], productIds[0], slotIds[0], '2030-01-01', null, vendorId],
    [subscriptionIds[3], productIds[1], slotIds[1], '2030-01-01', null, vendorId],
    [subscriptionIds[4], otherProductId, otherSlotId, '2030-01-01', null, otherVendorId],
  ] as const;
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    for (const [subscriptionId, productId, slotId, from, to, revisionVendorId] of revisions) {
      const revisionId = randomUUID();
      await client.query(
        `INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,effective_to,created_by,updated_at)
         SELECT $1,s.vendor_id,$2,$3,p.default_unit_id,$4,1,'active',$5,$6,$7,now()
         FROM subscriptions s JOIN products p ON p.vendor_id=s.vendor_id AND p.id=$3 WHERE s.id=$2`,
        [revisionId, subscriptionId, productId, slotId, from, to, userId],
      );
      await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,1)', [revisionVendorId, revisionId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { userId, vendorId, otherVendorId, householdId, otherHouseholdId, subscriptionIds, productIds, slotIds };
}

async function cleanup(value: Fixture) {
  const vendorIds = [value.vendorId, value.otherVendorId];
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM subscription_revision_weekdays WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
    await client.query('DELETE FROM subscription_revisions WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await owner.query('DELETE FROM subscriptions WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM delivery_slots WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM products WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM units WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM households WHERE vendor_id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendorIds]);
  await owner.query('DELETE FROM users WHERE id=$1', [value.userId]);
}

void test('reader returns only requested tenant-visible preserved labels in stable order', async () => {
  const value = await fixture();
  try {
    const matches = await transactions.run(value.vendorId, (tx) => reader.read(tx, {
      vendorId: value.vendorId,
      householdId: value.householdId,
      references: [
        { kind: 'range', referenceId: 'range', subscriptionId: value.subscriptionIds[0], startDate: '2030-01-01', endDate: '2030-01-31' },
        { kind: 'occurrence', referenceId: 'occurrence', subscriptionId: value.subscriptionIds[1], serviceDate: '2030-01-20', deliverySlotId: value.slotIds[2] },
        { kind: 'occurrence', referenceId: 'wrong-slot', subscriptionId: value.subscriptionIds[1], serviceDate: '2030-01-20', deliverySlotId: value.slotIds[0] },
        { kind: 'range', referenceId: 'deleted', subscriptionId: value.subscriptionIds[2], startDate: '2030-01-01', endDate: '2030-01-31' },
        { kind: 'range', referenceId: 'other-household', subscriptionId: value.subscriptionIds[3], startDate: '2030-01-01', endDate: '2030-01-31' },
        { kind: 'range', referenceId: 'other-vendor', subscriptionId: value.subscriptionIds[4], startDate: '2030-01-01', endDate: '2030-01-31' },
      ],
    }));

    const expected: SubscriptionLabelMatch[] = [
      {
        referenceId: 'occurrence', subscriptionId: value.subscriptionIds[1],
        productId: value.productIds[2], productName: 'Product 2',
        deliverySlotId: value.slotIds[2], deliverySlotName: 'Slot 2',
      },
      {
        referenceId: 'range', subscriptionId: value.subscriptionIds[0],
        productId: value.productIds[0], productName: 'Product 0',
        deliverySlotId: value.slotIds[0], deliverySlotName: 'Slot 0',
      },
      {
        referenceId: 'range', subscriptionId: value.subscriptionIds[0],
        productId: value.productIds[1], productName: 'Product 1',
        deliverySlotId: value.slotIds[1], deliverySlotName: 'Slot 1',
      },
    ];
    expected.sort((left, right) => left.referenceId.localeCompare(right.referenceId)
      || left.subscriptionId.localeCompare(right.subscriptionId)
      || left.productId.localeCompare(right.productId)
      || left.deliverySlotId.localeCompare(right.deliverySlotId));
    assert.deepEqual(matches, expected);
  } finally {
    await cleanup(value);
  }
});
