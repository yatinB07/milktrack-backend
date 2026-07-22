import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import { ApplicationError } from '../src/common/errors/application.error.js';
import { DefaultDeliveryLeaveProjection } from '../src/delivery/application/delivery-leave.projection.js';
import { PrismaDeliveryStore } from '../src/delivery/infrastructure/prisma-delivery.store.js';
import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';

const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const store = new PrismaDeliveryStore();
test.after(() => Promise.all([prisma.$disconnect(), owner.end()]));

type Fixture = Readonly<{
  vendorId: string;
  householdId: string;
  otherHouseholdId: string;
  deliveryId: string;
  actorUserId: string;
  subscriptionId: string;
  revisionId: string;
  productId: string;
  unitId: string;
  slotId: string;
}>;

async function fixture(label: string): Promise<Fixture> {
  const vendorId = randomUUID(); const actorUserId = randomUUID(); const householdId = randomUUID();
  const otherHouseholdId = randomUUID(); const unitId = randomUUID(); const productId = randomUUID();
  const slotId = randomUUID(); const subscriptionId = randomUUID(); const revisionId = randomUUID(); const deliveryId = randomUUID();
  await owner.query(`INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())`, [actorUserId, `${label} actor`]);
  await owner.query(`INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,$2,$2,'active','Asia/Kolkata','INR',0,1,now())`, [vendorId, `delivery-${label}-${vendorId.slice(0, 8)}`]);
  for (const [id, account] of [[householdId, 'A'], [otherHouseholdId, 'B']] as const) {
    await owner.query(`INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES($1,$2,$3,$3,'Road','Pune','MH','411001','IN',now())`, [id, vendorId, `${label}-${account}`]);
  }
  await owner.query(`INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,'LITRE','Litre',3,now())`, [unitId, vendorId]);
  await owner.query(`INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,'MILK','Milk',$3,now())`, [productId, vendorId, unitId]);
  await owner.query(`INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,'AM','Morning','06:00','09:00',now())`, [slotId, vendorId]);
  await owner.query(`INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())`, [subscriptionId, vendorId, householdId]);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'active','2029-01-01',$7,now())`, [revisionId, vendorId, subscriptionId, productId, unitId, slotId, actorUserId]);
    await client.query(`INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,1)`, [vendorId, revisionId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  await owner.query(`INSERT INTO scheduled_deliveries(id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,delivery_slot_id,service_date,planned_quantity,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'2030-01-01',1,now())`, [deliveryId, vendorId, subscriptionId, revisionId, householdId, productId, unitId, slotId]);
  return { vendorId, householdId, otherHouseholdId, deliveryId, actorUserId, subscriptionId, revisionId, productId, unitId, slotId };
}

async function cleanup(value: Fixture) {
  const { vendorId } = value;
  await owner.query('DELETE FROM delivery_price_snapshots WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM delivery_events WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM scheduled_deliveries WHERE vendor_id=$1', [vendorId]);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM subscription_revision_weekdays WHERE vendor_id=$1', [vendorId]);
    await client.query('DELETE FROM subscription_revisions WHERE vendor_id=$1', [vendorId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  await owner.query('DELETE FROM subscriptions WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM products WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM units WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM delivery_slots WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM households WHERE vendor_id=$1', [vendorId]);
  await owner.query('DELETE FROM vendors WHERE id=$1', [vendorId]);
  await owner.query('DELETE FROM users WHERE id=$1', [value.actorUserId]);
}

void test('delivery store appends before final projection, fences stale versions, and protects snapshots', async () => {
  const value = await fixture('store');
  const now = new Date('2030-01-01T06:30:00.000Z');
  try {
    await assert.rejects(
      transactions.run(value.vendorId, (tx) => store.appendFinalOutcome(tx, {
        id: randomUUID(), vendorId: value.vendorId, scheduledDeliveryId: value.deliveryId, expectedVersion: 1,
        outcome: 'delivered', source: 'delivery_agent', actorUserId: value.actorUserId,
        occurredAt: now, receivedAt: now, actualQuantity: '1.500',
      })),
      (error: unknown) => error instanceof ApplicationError
        && error.code === 'DELIVERY_PRICE_SNAPSHOT_REQUIRED',
    );
    await transactions.run(value.vendorId, (tx) => store.createPriceSnapshot(tx, {
      vendorId: value.vendorId, scheduledDeliveryId: value.deliveryId, amountMinor: '1000', currency: 'INR',
      pricingLevel: 'global', sourcePriceId: randomUUID(), sourcePriceType: 'global_price', resolvedAt: now,
    }));
    const result = await transactions.run(value.vendorId, (tx) => store.appendFinalOutcome(tx, {
      id: randomUUID(), vendorId: value.vendorId, scheduledDeliveryId: value.deliveryId, expectedVersion: 1,
      outcome: 'delivered', source: 'delivery_agent', actorUserId: value.actorUserId,
      occurredAt: now, receivedAt: now, actualQuantity: '1.500',
    }));
    assert.equal(result.currentStatus, 'delivered');
    assert.equal(result.version, 2);
    const detail = await transactions.run(value.vendorId, (tx) => store.getVendorDetail(tx, value.vendorId, value.deliveryId));
    assert.equal(detail.currentStatus, 'delivered');
    assert.equal(detail.actualQuantity, '1.5');
    assert.equal(detail.events.length, 1);
    assert.equal(detail.events[0]?.actualQuantity, '1.5');
    assert.equal(detail.snapshot?.amountMinor, '1000');
    await assert.rejects(
      transactions.run(value.vendorId, (tx) => store.appendFinalOutcome(tx, {
        id: randomUUID(), vendorId: value.vendorId, scheduledDeliveryId: value.deliveryId, expectedVersion: 1,
        outcome: 'missed', source: 'delivery_agent', actorUserId: value.actorUserId, occurredAt: now, receivedAt: now,
      })),
      (error: unknown) => error instanceof ApplicationError && error.code === 'STALE_VERSION',
    );
    await assert.rejects(
      transactions.run(value.vendorId, (tx) => store.createPriceSnapshot(tx, {
        vendorId: value.vendorId, scheduledDeliveryId: value.deliveryId, amountMinor: '1000', currency: 'INR',
        pricingLevel: 'global', sourcePriceId: randomUUID(), sourcePriceType: 'global_price', resolvedAt: now,
      })),
      (error: unknown) => error instanceof ApplicationError && error.code === 'DELIVERY_SNAPSHOT_EXISTS',
    );
    await assert.rejects(
      transactions.run(value.vendorId, (tx) => store.appendCorrection(tx, {
        id: randomUUID(), vendorId: value.vendorId, scheduledDeliveryId: value.deliveryId,
        expectedVersion: 2, replacementOutcome: 'missed', actorUserId: value.actorUserId,
        occurredAt: now, receivedAt: now, reason: 'x',
      })),
      (error: unknown) => error instanceof ApplicationError
        && error.code === 'INVALID_CORRECTION_REASON',
    );
    await assert.rejects(
      transactions.run(value.vendorId, (tx) => store.getCustomerDetail(tx, value.vendorId, value.otherHouseholdId, value.deliveryId)),
      (error: unknown) => error instanceof ApplicationError && error.code === 'DELIVERY_NOT_FOUND',
    );
  } finally { await cleanup(value); }
});

void test('correction to delivered requires an existing price snapshot', async () => {
  const value = await fixture('correction-snapshot');
  const now = new Date('2030-01-01T06:30:00.000Z');
  try {
    await transactions.run(value.vendorId, (tx) => store.appendFinalOutcome(tx, {
      id: randomUUID(), vendorId: value.vendorId, scheduledDeliveryId: value.deliveryId, expectedVersion: 1,
      outcome: 'missed', source: 'delivery_agent', actorUserId: value.actorUserId,
      occurredAt: now, receivedAt: now, reasonCode: 'other', note: 'Road closed',
    }));
    await assert.rejects(
      transactions.run(value.vendorId, (tx) => store.appendCorrection(tx, {
        id: randomUUID(), vendorId: value.vendorId, scheduledDeliveryId: value.deliveryId,
        expectedVersion: 2, replacementOutcome: 'delivered', actualQuantity: '1',
        actorUserId: value.actorUserId, occurredAt: now, receivedAt: now, reason: 'Confirmed delivery',
      })),
      (error: unknown) => error instanceof ApplicationError
        && error.code === 'DELIVERY_PRICE_SNAPSHOT_REQUIRED',
    );
  } finally { await cleanup(value); }
});

void test('leave reversal appends an immutable event that references the latest leave-owned customer skip', async () => {
  const value = await fixture('leave');
  try {
    const key = await transactions.run(value.vendorId, async (tx) => {
      const record = await store.getVendorDetail(tx, value.vendorId, value.deliveryId);
      return { vendorId: value.vendorId, subscriptionId: record.subscriptionId, serviceDate: record.serviceDate, deliverySlotId: record.deliverySlotId };
    });
    const projection = new DefaultDeliveryLeaveProjection(store);
    await transactions.run(value.vendorId, (tx) => projection.applyCustomerLeave(tx, key, value.actorUserId));
    const before = await transactions.run(value.vendorId, (tx) => store.getVendorDetail(tx, value.vendorId, value.deliveryId));
    const originalSkipEventId = before.events[0]?.id;
    await transactions.run(value.vendorId, (tx) => projection.reverseCustomerLeave(tx, key, value.actorUserId));
    const after = await transactions.run(value.vendorId, (tx) => store.getVendorDetail(tx, value.vendorId, value.deliveryId));
    assert.equal(after.currentStatus, 'scheduled');
    assert.equal(after.finalizedAt, undefined);
    assert.equal(after.version, before.version + 1);
    assert.deepEqual(after.events.map(({ eventType }) => eventType), ['skipped_by_customer', 'scheduled']);
    assert.equal(after.events.at(-1)?.source, 'customer');
    assert.equal(after.events.at(-1)?.actorUserId, value.actorUserId);
    assert.equal(after.events.at(-1)?.reasonCode, 'customer_leave_reversed');
    assert.equal(after.events.at(-1)?.replacedEventId, originalSkipEventId);

    await transactions.run(value.vendorId, (tx) => projection.reverseCustomerLeave(tx, key, value.actorUserId));
    const repeated = await transactions.run(value.vendorId, (tx) => store.getVendorDetail(tx, value.vendorId, value.deliveryId));
    assert.equal(repeated.version, after.version);
    assert.equal(repeated.events.length, after.events.length);

    await transactions.run(value.vendorId, (tx) => projection.applyCustomerLeave(tx, key, value.actorUserId, 'vendor_admin'));
    await transactions.run(value.vendorId, (tx) => projection.reverseCustomerLeave(tx, key, value.actorUserId));
    assert.equal((await transactions.run(value.vendorId, (tx) => store.getVendorDetail(tx, value.vendorId, value.deliveryId))).currentStatus, 'scheduled');

    await transactions.run(value.vendorId, (tx) => projection.applyCustomerLeave(tx, key, value.actorUserId));
    await owner.query(`INSERT INTO delivery_events(
      id,vendor_id,scheduled_delivery_id,event_type,source,occurred_at,received_at
    ) VALUES($1,$2,$3,'skipped_by_customer','system',now(),now())`, [randomUUID(), value.vendorId, value.deliveryId]);
    await transactions.run(value.vendorId, (tx) => projection.reverseCustomerLeave(tx, key, value.actorUserId));
    assert.equal((await transactions.run(value.vendorId, (tx) => store.getVendorDetail(tx, value.vendorId, value.deliveryId))).currentStatus, 'skipped_by_customer');
    assert.equal((await owner.query<{ count: number }>('SELECT count(*)::int AS count FROM delivery_events WHERE vendor_id=$1', [value.vendorId])).rows[0]?.count, 6);
  } finally { await cleanup(value); }
});

void test('leave reversal accepts a generated customer-leave skip and preserves final agent outcomes', async () => {
  const generated = await fixture('generated-leave');
  const final = await fixture('final-outcome');
  const now = new Date();
  try {
    const generatedRecord = await transactions.run(generated.vendorId, (tx) => store.getVendorDetail(tx, generated.vendorId, generated.deliveryId));
    await owner.query(`INSERT INTO delivery_events(id,vendor_id,scheduled_delivery_id,event_type,source,occurred_at,received_at,reason_code)
      VALUES($1,$2,$3,'skipped_by_customer','system',$4,$4,'customer_on_leave')`, [randomUUID(), generated.vendorId, generated.deliveryId, now]);
    await owner.query(`UPDATE scheduled_deliveries SET status='skipped_by_customer',finalized_at=$2,version=2,updated_at=$2 WHERE id=$1`, [generated.deliveryId, now]);
    const generatedKey = { vendorId: generated.vendorId, subscriptionId: generatedRecord.subscriptionId, serviceDate: generatedRecord.serviceDate, deliverySlotId: generatedRecord.deliverySlotId };
    await transactions.run(generated.vendorId, (tx) => store.reverseCustomerLeave(tx, generatedKey, generated.actorUserId, 'vendor_admin'));
    const reversed = await transactions.run(generated.vendorId, (tx) => store.getVendorDetail(tx, generated.vendorId, generated.deliveryId));
    assert.equal(reversed.currentStatus, 'scheduled');
    assert.equal(reversed.events.at(-1)?.source, 'vendor_admin');

    await transactions.run(final.vendorId, (tx) => store.appendFinalOutcome(tx, {
      id: randomUUID(), vendorId: final.vendorId, scheduledDeliveryId: final.deliveryId, expectedVersion: 1,
      outcome: 'missed', source: 'delivery_agent', actorUserId: final.actorUserId,
      occurredAt: now, receivedAt: now, reasonCode: 'other', note: 'Road closed',
    }));
    const finalRecord = await transactions.run(final.vendorId, (tx) => store.getVendorDetail(tx, final.vendorId, final.deliveryId));
    const finalKey = { vendorId: final.vendorId, subscriptionId: finalRecord.subscriptionId, serviceDate: finalRecord.serviceDate, deliverySlotId: finalRecord.deliverySlotId };
    await transactions.run(final.vendorId, (tx) => store.reverseCustomerLeave(tx, finalKey, final.actorUserId));
    assert.deepEqual(await transactions.run(final.vendorId, (tx) => store.getVendorDetail(tx, final.vendorId, final.deliveryId)), finalRecord);
  } finally {
    await cleanup(generated);
    await cleanup(final);
  }
});

void test('failed leave-reversal event insertion leaves the projection and original skip unchanged', async () => {
  const value = await fixture('leave-rollback');
  try {
    const record = await transactions.run(value.vendorId, (tx) => store.getVendorDetail(tx, value.vendorId, value.deliveryId));
    const key = { vendorId: value.vendorId, subscriptionId: record.subscriptionId, serviceDate: record.serviceDate, deliverySlotId: record.deliverySlotId };
    await transactions.run(value.vendorId, (tx) => store.applyCustomerLeave(tx, key, value.actorUserId));
    const before = await transactions.run(value.vendorId, (tx) => store.getVendorDetail(tx, value.vendorId, value.deliveryId));

    await assert.rejects(
      transactions.run(value.vendorId, (tx) => store.reverseCustomerLeave(tx, key, randomUUID())),
      /foreign key|delivery_events_actor_user_fkey/iu,
    );

    const after = await transactions.run(value.vendorId, (tx) => store.getVendorDetail(tx, value.vendorId, value.deliveryId));
    assert.deepEqual(after, before);
  } finally { await cleanup(value); }
});

void test('bounded leave reconciliation pages compact selections and synchronizes only eligible tenant rows', async () => {
  const value = await fixture('bounded-leave');
  const foreign = await fixture('bounded-foreign');
  const projection = new DefaultDeliveryLeaveProjection(store);
  const agentUserId = randomUUID(); const agentMembershipId = randomUUID(); const routeId = randomUUID();
  try {
    await owner.query(`INSERT INTO scheduled_deliveries(
      id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,delivery_slot_id,
      service_date,planned_quantity,updated_at
    ) SELECT gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,date '2030-01-01'+series,1,now()
      FROM generate_series(1,105) series`, [
      value.vendorId, value.subscriptionId, value.revisionId, value.householdId,
      value.productId, value.unitId, value.slotId,
    ]);
    await owner.query(`INSERT INTO scheduled_deliveries(
      id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,delivery_slot_id,
      service_date,planned_quantity,updated_at
    ) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'2031-01-01',1,now())`, [
      value.vendorId, value.subscriptionId, value.revisionId, value.householdId,
      value.productId, value.unitId, value.slotId,
    ]);

    const selections = [
      { startDate: '2030-01-01', endDate: '2030-02-28', subscriptionIds: [value.subscriptionId] },
      { startDate: '2030-03-01', endDate: '2030-04-16', subscriptionIds: [value.subscriptionId, foreign.subscriptionId] },
    ];
    const first = await transactions.run(value.vendorId, (tx) => projection.listAffected(tx, value.vendorId, selections, { limit: 100 }));
    assert.equal(first.items.length, 100);
    assert.ok(first.nextCursor);
    const second = await transactions.run(value.vendorId, (tx) => projection.listAffected(tx, value.vendorId, selections, { cursor: first.nextCursor, limit: 100 }));
    const affected = [...first.items, ...second.items];
    assert.equal(second.items.length, 6);
    assert.equal(second.nextCursor, undefined);
    assert.equal(affected.every(({ vendorId, subscriptionId }) => vendorId === value.vendorId && subscriptionId === value.subscriptionId), true);
    assert.deepEqual(
      affected.map(({ serviceDate, id }) => `${serviceDate}:${id}`),
      affected.map(({ serviceDate, id }) => `${serviceDate}:${id}`).toSorted(),
    );

    const [newSkip, reverse, unchanged, finalized, alreadySkipped, secondNewSkip, stale, rollbackPeer] = affected;
    assert(newSkip && reverse && unchanged && finalized && alreadySkipped && secondNewSkip && stale && rollbackPeer);
    await owner.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [agentUserId, 'Bounded leave agent']);
    await owner.query(`INSERT INTO vendor_memberships(id,vendor_id,user_id,role,status,joined_at,updated_at)
      VALUES($1,$2,$3,'delivery_agent','active',now(),now())`, [agentMembershipId, value.vendorId, agentUserId]);
    await owner.query(`INSERT INTO routes(id,vendor_id,code,name,delivery_slot_id,updated_at)
      VALUES($1,$2,$3,'Bounded leave route',$4,now())`, [routeId, value.vendorId, `LEAVE_${routeId.slice(0, 8).toUpperCase()}`, value.slotId]);
    for (const delivery of [newSkip, secondNewSkip, alreadySkipped]) {
      const assignmentId = randomUUID();
      await owner.query(`INSERT INTO route_assignments(
        id,vendor_id,route_id,delivery_slot_id,agent_membership_id,service_date,status,created_by,updated_by,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,'assigned',$7,$7,now())`, [
        assignmentId, value.vendorId, routeId, value.slotId, agentMembershipId, delivery.serviceDate, value.actorUserId,
      ]);
      await owner.query('UPDATE scheduled_deliveries SET route_assignment_id=$1 WHERE id=$2', [assignmentId, delivery.id]);
    }
    await transactions.run(value.vendorId, (tx) => store.applyCustomerLeave(tx, reverse, value.actorUserId));
    await transactions.run(value.vendorId, (tx) => store.applyCustomerLeave(tx, alreadySkipped, value.actorUserId));
    await transactions.run(value.vendorId, (tx) => store.appendFinalOutcome(tx, {
      id: randomUUID(), vendorId: value.vendorId, scheduledDeliveryId: finalized.id, expectedVersion: finalized.version,
      outcome: 'missed', source: 'delivery_agent', actorUserId: value.actorUserId,
      occurredAt: new Date(), receivedAt: new Date(), reasonCode: 'access_blocked',
    }));

    await assert.rejects(transactions.run(value.vendorId, (tx) => projection.synchronize(tx, {
      userId: value.actorUserId, source: 'vendor_admin',
    }, [
      { ...rollbackPeer, effective: true },
      { ...stale, version: stale.version + 1, effective: true },
    ])), (error: unknown) => error instanceof ApplicationError && error.code === 'STALE_VERSION');

    const result = await transactions.run(value.vendorId, (tx) => projection.synchronize(tx, {
      userId: value.actorUserId, source: 'vendor_admin',
    }, [
      { ...secondNewSkip, effective: true },
      { ...newSkip, effective: true },
      { ...reverse, version: reverse.version + 1, effective: false },
      { ...unchanged, effective: false },
      { ...finalized, effective: true },
      { ...alreadySkipped, version: alreadySkipped.version + 1, effective: true },
      { ...foreign, id: foreign.deliveryId, version: 1, serviceDate: '2030-01-01', deliverySlotId: foreign.slotId, effective: true },
    ]));
    assert.deepEqual(result.agentMembershipIds, [agentMembershipId]);

    const details = await Promise.all([newSkip, reverse, unchanged, finalized, alreadySkipped, secondNewSkip, stale, rollbackPeer].map(({ id }) =>
      transactions.run(value.vendorId, (tx) => store.getVendorDetail(tx, value.vendorId, id))));
    assert.deepEqual(details.map(({ currentStatus }) => currentStatus), [
      'skipped_by_customer', 'scheduled', 'scheduled', 'missed', 'skipped_by_customer',
      'skipped_by_customer', 'scheduled', 'scheduled',
    ]);
    assert.deepEqual(details.map(({ events }) => events.map(({ eventType }) => eventType)), [
      ['skipped_by_customer'], ['skipped_by_customer', 'scheduled'], [], ['missed'], ['skipped_by_customer'],
      ['skipped_by_customer'], [], [],
    ]);
  } finally {
    await owner.query('UPDATE scheduled_deliveries SET route_assignment_id=NULL WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM route_assignments WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM routes WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('DELETE FROM vendor_memberships WHERE vendor_id=$1 AND id=$2', [value.vendorId, agentMembershipId]);
    await cleanup(value);
    await cleanup(foreign);
    await owner.query('DELETE FROM users WHERE id=$1', [agentUserId]);
  }
});
