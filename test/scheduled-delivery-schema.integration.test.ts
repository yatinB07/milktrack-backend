import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { INestApplication } from '@nestjs/common';
import { DateTime } from 'luxon';
import { SchedulingPriceService } from '../src/pricing/application/scheduling-price.service.js';
import { PrismaService } from '../src/database/infrastructure/prisma.service.js';
import { PrismaTenantTransactionRunner } from '../src/database/infrastructure/prisma-tenant-transaction.runner.js';
import { PrismaScheduledDeliveryStore } from '../src/scheduling/infrastructure/prisma-scheduled-delivery.store.js';
import { TenantTransactionRunner } from '../src/common/application/transaction-context.js';
import { ScheduleGenerator } from '../src/scheduling/application/schedule-generator.js';

const runtime = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const prisma = new PrismaService();
const transactions = new PrismaTenantTransactionRunner(prisma);
const scheduledDeliveries = new PrismaScheduledDeliveryStore();
const authKey = Buffer.from(process.env.AUTH_HMAC_KEY!, 'base64');
let app: INestApplication; let baseUrl = '';
test.before(async () => {
  const { createApp } = await import('../src/bootstrap/create-app.js'); app = await createApp({ logger: false });
  await app.listen(0, '127.0.0.1'); const address = (app.getHttpServer() as Server).address();
  assert.ok(address && typeof address !== 'string'); baseUrl = `http://127.0.0.1:${address.port}`;
});
test.after(() => Promise.all([app.close(), runtime.end(), owner.end(), prisma.$disconnect()]));

async function session(userId: string, method: 'administrator_mfa' | 'phone_otp') {
  const token = randomUUID(); const hash = (value: string) => createHmac('sha256', authKey).update(value).digest('hex');
  await owner.query("INSERT INTO sessions(id,user_id,access_token_hash,refresh_token_hash,authentication_method,device_id,access_expires_at,expires_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now()+interval '1 day',now())", [randomUUID(), userId, hash(token), hash(randomUUID()), method, `schedule-${userId}`]);
  return token;
}

async function fixture(label: string) {
  const value = {
    userId: randomUUID(), vendorId: randomUUID(), householdId: randomUUID(), otherHouseholdId: randomUUID(),
    unitId: randomUUID(), productId: randomUUID(), slotId: randomUUID(), otherSlotId: randomUUID(),
    subscriptionId: randomUUID(), revisionId: randomUUID(), otherRevisionId: randomUUID(), agentUserId: randomUUID(), membershipId: randomUUID(), ownerMembershipId: randomUUID(),
    routeId: randomUUID(), assignmentId: randomUUID(), planId: randomUUID(), stopId: randomUUID(),
    otherRouteId: randomUUID(), otherAssignmentId: randomUUID(), otherPlanId: randomUUID(), otherStopId: randomUUID(),
  };
  const client = await owner.connect();
  await client.query('BEGIN');
  try {
    await client.query('INSERT INTO users(id,display_name,updated_at) VALUES ($1,$2,now()),($3,$4,now())', [value.userId, `Owner ${label}`, value.agentUserId, `Agent ${label}`]);
    await client.query("INSERT INTO vendors(id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES($1,$2,$3,$3,'active','Asia/Kolkata','INR',0,1,now())", [value.vendorId, `schedule-${value.vendorId}`, `Schedule ${label}`]);
    for (const [id, account] of [[value.householdId, `S-${label}`], [value.otherHouseholdId, `O-${label}`]]) await client.query("INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES($1,$2,$3,$3,'Road','Pune','MH','411001','IN',now())", [id, value.vendorId, account]);
    await client.query('INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,$3,$4,2,now())', [value.unitId, value.vendorId, `UNIT_${value.unitId.slice(0, 8).toUpperCase()}`, `Unit ${label}`]);
    await client.query('INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [value.productId, value.vendorId, `PRODUCT_${value.productId.slice(0, 8).toUpperCase()}`, `Product ${label}`, value.unitId]);
    await client.query("INSERT INTO global_prices(id,vendor_id,product_id,unit_id,amount_minor,currency,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,100,'INR','2029-01-01',$5,now())", [randomUUID(), value.vendorId, value.productId, value.unitId, value.userId]);
    for (const [id, name, start, end] of [[value.slotId, `Slot ${label}`, '06:00', '09:00'], [value.otherSlotId, `Other ${label}`, '10:00', '12:00']]) await client.query('INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,$3,$4,$5,$6,now())', [id, value.vendorId, `SLOT_${id.slice(0, 8).toUpperCase()}`, name, start, end]);
    await client.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [value.subscriptionId, value.vendorId, value.householdId]);
    await client.query("INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,effective_to,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1.25,'active','2030-01-01','2030-01-02',$7,now())", [value.revisionId, value.vendorId, value.subscriptionId, value.productId, value.unitId, value.slotId, value.userId]);
    await client.query('INSERT INTO subscription_revision_weekdays VALUES($1,$2,2)', [value.vendorId, value.revisionId]);
    await client.query("INSERT INTO subscription_revisions(id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1.25,'active','2030-01-02',$7,now())", [value.otherRevisionId, value.vendorId, value.subscriptionId, value.productId, value.unitId, value.otherSlotId, value.userId]);
    await client.query('INSERT INTO subscription_revision_weekdays VALUES($1,$2,3)', [value.vendorId, value.otherRevisionId]);
    await client.query("INSERT INTO vendor_memberships(id,vendor_id,user_id,role,status,joined_at,updated_at) VALUES($1,$2,$3,'delivery_agent','active',now(),now())", [value.membershipId, value.vendorId, value.agentUserId]);
    await client.query("INSERT INTO vendor_memberships(id,vendor_id,user_id,role,status,joined_at,updated_at) VALUES($1,$2,$3,'vendor_owner','active',now(),now())", [value.ownerMembershipId, value.vendorId, value.userId]);
    await client.query("INSERT INTO mfa_factors(id,user_id,type,encrypted_secret,enabled_at) VALUES($1,$2,'totp','schedule',now())", [randomUUID(), value.userId]);
    await client.query('INSERT INTO routes(id,vendor_id,code,name,delivery_slot_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [value.routeId, value.vendorId, `ROUTE_${value.routeId.slice(0, 8).toUpperCase()}`, `Route ${label}`, value.slotId]);
    await client.query("INSERT INTO route_assignments(id,vendor_id,route_id,delivery_slot_id,agent_membership_id,service_date,created_by,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,'2030-01-01',$6,$6,now())", [value.assignmentId, value.vendorId, value.routeId, value.slotId, value.membershipId, value.userId]);
    await client.query("INSERT INTO route_stop_plans(id,vendor_id,route_id,delivery_slot_id,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,'2030-01-01',$5,now())", [value.planId, value.vendorId, value.routeId, value.slotId, value.userId]);
    await client.query("INSERT INTO route_stops(id,vendor_id,route_id,plan_id,household_id,delivery_slot_id,sequence,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'2030-01-01',$7,now())", [value.stopId, value.vendorId, value.routeId, value.planId, value.householdId, value.slotId, value.userId]);
    await client.query('INSERT INTO routes(id,vendor_id,code,name,delivery_slot_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [value.otherRouteId, value.vendorId, `ROUTE_${value.otherRouteId.slice(0, 8).toUpperCase()}`, `Other route ${label}`, value.otherSlotId]);
    await client.query("INSERT INTO route_assignments(id,vendor_id,route_id,delivery_slot_id,agent_membership_id,service_date,created_by,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,'2030-01-01',$6,$6,now())", [value.otherAssignmentId, value.vendorId, value.otherRouteId, value.otherSlotId, value.membershipId, value.userId]);
    await client.query("INSERT INTO route_stop_plans(id,vendor_id,route_id,delivery_slot_id,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,'2030-01-01',$5,now())", [value.otherPlanId, value.vendorId, value.otherRouteId, value.otherSlotId, value.userId]);
    await client.query("INSERT INTO route_stops(id,vendor_id,route_id,plan_id,household_id,delivery_slot_id,sequence,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,'2030-01-01',$7,now())", [value.otherStopId, value.vendorId, value.otherRouteId, value.otherPlanId, value.householdId, value.otherSlotId, value.userId]);
    await client.query('COMMIT');
    return { ...value, agentToken: await session(value.agentUserId, 'phone_otp'), ownerToken: await session(value.userId, 'administrator_mfa') };
  } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const insert = (value: Fixture, overrides: Partial<{ id: string; revisionId: string; householdId: string; productId: string; slotId: string; assignmentId: string | null; serviceDate: string; finalized: boolean }> = {}) => owner.query<{ id: string }>(
  `INSERT INTO scheduled_deliveries(id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,delivery_slot_id,route_assignment_id,service_date,planned_quantity,status,finalized_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1.25,'scheduled',CASE WHEN $11 THEN now() END,now()) RETURNING id`,
  [overrides.id ?? randomUUID(), value.vendorId, value.subscriptionId, overrides.revisionId ?? value.revisionId, overrides.householdId ?? value.householdId, overrides.productId ?? value.productId, value.unitId, overrides.slotId ?? value.slotId, overrides.assignmentId === undefined ? value.assignmentId : overrides.assignmentId, overrides.serviceDate ?? '2030-01-01', overrides.finalized ?? false],
);

async function cleanup(values: Fixture[]) {
  const vendors = values.map(({ vendorId }) => vendorId); const users = values.flatMap(({ userId, agentUserId }) => [userId, agentUserId]);
  const client = await owner.connect();
  try {
    await client.query('BEGIN'); await client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const table of ['schedule_generation_runs','audit_events','scheduled_deliveries','route_stops','route_stop_plans','route_assignments','routes','subscription_revision_weekdays','subscription_revisions','subscriptions','customer_price_overrides','global_prices','vendor_memberships','delivery_slots','products','units','households']) await client.query(`DELETE FROM ${table} WHERE vendor_id=ANY($1::uuid[])`, [vendors]);
    await client.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [users]); await client.query('DELETE FROM mfa_factors WHERE user_id=ANY($1::uuid[])', [users]);
    await client.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendors]); await client.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    await client.query('COMMIT');
  } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
}

async function asTenant(vendorId: string, work: (client: pg.PoolClient) => Promise<void>) {
  const client = await runtime.connect(); try { await client.query('BEGIN'); await client.query("SELECT set_config('app.vendor_id',$1,true)", [vendorId]); await work(client); } finally { await client.query('ROLLBACK'); client.release(); }
}

async function waitForAdvisoryWaiters(lockKey: string, expected: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // PostgreSQL exposes a one-key bigint advisory lock as unsigned high/low halves.
    const result = await owner.query<{ count: number }>(`WITH target AS (SELECT hashtextextended($1,0) value)
      SELECT count(*)::int count FROM pg_locks,target WHERE locktype='advisory' AND NOT granted
        AND classid::bigint=((value >> 32) & 4294967295) AND objid::bigint=(value & 4294967295)`, [lockKey]);
    if ((result.rows[0]?.count ?? 0) >= expected) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${expected} advisory lock waiter(s)`);
}

async function within<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function moveFixtureToDate(value: Fixture, serviceDate: string) {
  const nextDate = DateTime.fromISO(serviceDate, { zone: 'UTC' }).plus({ days: 1 }).toISODate()!;
  const weekday = DateTime.fromISO(serviceDate, { zone: 'UTC' }).weekday;
  await owner.query('UPDATE subscription_revisions SET effective_from=$2,effective_to=$3,updated_at=now() WHERE id=$1', [value.revisionId, serviceDate, nextDate]);
  await owner.query('UPDATE subscription_revision_weekdays SET weekday=$2 WHERE subscription_revision_id=$1', [value.revisionId, weekday]);
  await owner.query('UPDATE route_assignments SET service_date=$2,updated_at=now() WHERE id=$1', [value.assignmentId, serviceDate]);
  await owner.query('UPDATE route_stop_plans SET effective_from=$2,updated_at=now() WHERE id=$1', [value.planId, serviceDate]);
  return { weekday };
}

async function generateAfterQueuedMutation(
  value: Fixture,
  serviceDate: string,
  startMutation: () => Promise<Response>,
) {
  const lockKey = `scheduling-vendor-date:${value.vendorId}:${serviceDate}`;
  const blocker = await owner.connect();
  let mutationSettled = false; let generationSettled = false;
  let mutation: Promise<void> | undefined; let generation: Promise<unknown> | undefined;
  let lockReleased = false;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey]);
    mutation = startMutation().then(async (response) => {
      mutationSettled = true;
      assert.equal(response.status, 200, await response.text());
    });
    await waitForAdvisoryWaiters(lockKey, 1);
    const mutationWasPending = !mutationSettled;
    generation = transactions.run(value.vendorId, (tx) => app.get(ScheduleGenerator).generate(tx, value.vendorId, serviceDate))
      .finally(() => { generationSettled = true; });
    await waitForAdvisoryWaiters(lockKey, 2);
    const generationWasPending = !generationSettled;
    await blocker.query('ROLLBACK');
    lockReleased = true;
    await within(Promise.all([mutation, generation]));
    assert.equal(mutationWasPending, true);
    assert.equal(generationWasPending, true);
  } finally {
    if (!lockReleased) await blocker.query('ROLLBACK').catch(() => undefined);
    await Promise.allSettled([mutation, generation].filter((promise): promise is Promise<unknown> => promise !== undefined));
    blocker.release();
  }
}

void test('scheduled delivery schema has exact composite references, forced RLS, narrow grants, and no delete', async () => {
  const names = ['scheduled_deliveries_subscription_household_fkey','scheduled_deliveries_revision_projection_fkey','scheduled_deliveries_route_assignment_fkey','scheduled_deliveries_business_key'];
  assert.equal((await owner.query('SELECT conname FROM pg_constraint WHERE conname=ANY($1::text[])', [names])).rowCount, names.length);
  assert.deepEqual((await owner.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='scheduled_deliveries'")).rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
  assert.equal((await owner.query<{ allowed: boolean }>("SELECT has_table_privilege('milktrack_app','scheduled_deliveries','DELETE') allowed")).rows[0]?.allowed, false);
  assert.equal((await owner.query<{ allowed: boolean }>("SELECT has_column_privilege('milktrack_app','scheduled_deliveries','service_date','UPDATE') allowed")).rows[0]?.allowed, false);
});

void test('exact projection, assignment date/slot, finalized occurrence, and checks reject corruption', async () => {
  const value = await fixture('constraints');
  try {
    await assert.rejects(insert(value, { householdId: value.otherHouseholdId }), /scheduled_deliveries_subscription_household_fkey/);
    await assert.rejects(insert(value, { productId: randomUUID() }), /scheduled_deliveries_revision_projection_fkey/);
    await assert.rejects(insert(value, { serviceDate: '2030-01-02' }), /scheduled_deliveries_route_assignment_fkey/);
    await insert(value, { finalized: true });
    await insert(value, { id: randomUUID(), revisionId: value.otherRevisionId, slotId: value.otherSlotId, assignmentId: null, finalized: true });
    await assert.rejects(insert(value, { id: randomUUID(), finalized: true }), /scheduled_deliveries_business_key/);
    await assert.rejects(owner.query('UPDATE scheduled_deliveries SET planned_quantity=0 WHERE vendor_id=$1', [value.vendorId]), /planned_quantity_check/);
  } finally { await cleanup([value]); }
});

void test('runtime scheduled delivery access is bidirectionally isolated and business identity is immutable', async () => {
  const values = [await fixture('tenant-a'), await fixture('tenant-b')];
  try {
    const ids = [(await insert(values[0])).rows[0].id, (await insert(values[1])).rows[0].id];
    for (const [index, other] of [[0, 1], [1, 0]] as const) await asTenant(values[index].vendorId, async (client) => {
      assert.equal((await client.query('SELECT id FROM scheduled_deliveries WHERE id=$1', [ids[index]])).rowCount, 1);
      assert.equal((await client.query('SELECT id FROM scheduled_deliveries WHERE id=$1', [ids[other]])).rowCount, 0);
      await assert.rejects(client.query("UPDATE scheduled_deliveries SET service_date='2030-01-02' WHERE id=$1", [ids[index]]), /permission denied/);
    });
    for (const [index] of [[0], [1]] as const) await asTenant(values[index].vendorId, async (client) => {
      await assert.rejects(client.query('DELETE FROM scheduled_deliveries WHERE id=$1', [ids[index]]), /permission denied/);
    });
  } finally { await cleanup(values); }
});

void test('agent self read paginates tied cross-route sequences and cancelled assignments hide immediately', async () => {
  const value = await fixture('agent-cursor');
  try {
    await insert(value);
    await insert(value, { revisionId: value.otherRevisionId, slotId: value.otherSlotId, assignmentId: value.otherAssignmentId });
    const first = await transactions.run(value.vendorId, (tx) => scheduledDeliveries.listSelf(tx, value.vendorId, value.membershipId, '2030-01-01', { limit: 1 }));
    assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
    const second = await transactions.run(value.vendorId, (tx) => scheduledDeliveries.listSelf(tx, value.vendorId, value.membershipId, '2030-01-01', { limit: 1, cursor: first.nextCursor }));
    assert.equal(second.items.length, 1); assert.notEqual(second.items[0]?.id, first.items[0]?.id);
    assert.deepEqual([...first.items, ...second.items].map(({ sequence }) => sequence), [1, 1]);
    const projected = [...first.items, ...second.items];
    for (const item of projected) {
      const primaryRoute = item.routeAssignmentId === value.assignmentId;
      assert.deepEqual({
        routeId: item.routeId,
        routeCode: item.routeCode,
        routeName: item.routeName,
        householdAccountNumber: item.householdAccountNumber,
        householdName: item.householdName,
        addressLine1: item.addressLine1,
        city: item.city,
        region: item.region,
        postalCode: item.postalCode,
        countryCode: item.countryCode,
        productCode: item.productCode,
        productName: item.productName,
        unitCode: item.unitCode,
        unitName: item.unitName,
        deliverySlotName: item.deliverySlotName,
        deliverySlotStartLocalTime: item.deliverySlotStartLocalTime,
        deliverySlotEndLocalTime: item.deliverySlotEndLocalTime,
      }, {
        routeId: primaryRoute ? value.routeId : value.otherRouteId,
        routeCode: `ROUTE_${(primaryRoute ? value.routeId : value.otherRouteId).slice(0, 8).toUpperCase()}`,
        routeName: primaryRoute ? 'Route agent-cursor' : 'Other route agent-cursor',
        householdAccountNumber: 'S-agent-cursor',
        householdName: 'S-agent-cursor',
        addressLine1: 'Road',
        city: 'Pune',
        region: 'MH',
        postalCode: '411001',
        countryCode: 'IN',
        productCode: `PRODUCT_${value.productId.slice(0, 8).toUpperCase()}`,
        productName: 'Product agent-cursor',
        unitCode: `UNIT_${value.unitId.slice(0, 8).toUpperCase()}`,
        unitName: 'Unit agent-cursor',
        deliverySlotName: primaryRoute ? 'Slot agent-cursor' : 'Other agent-cursor',
        deliverySlotStartLocalTime: primaryRoute ? '06:00' : '10:00',
        deliverySlotEndLocalTime: primaryRoute ? '09:00' : '12:00',
      });
      assert.equal('addressLine2' in item, false);
      assert.equal('locality' in item, false);
    }
    const sameTenantOtherMembership = await transactions.run(value.vendorId, (tx) => scheduledDeliveries.listSelf(tx, value.vendorId, value.ownerMembershipId, '2030-01-01', {}));
    assert.deepEqual(sameTenantOtherMembership.items, []);
    await owner.query("UPDATE route_assignments SET status='cancelled',cancelled_at=now(),cancellation_reason='Agent unavailable',updated_at=now() WHERE id=$1", [value.otherAssignmentId]);
    const afterCancellation = await transactions.run(value.vendorId, (tx) => scheduledDeliveries.listSelf(tx, value.vendorId, value.membershipId, '2030-01-01', {}));
    assert.equal(afterCancellation.items.length, 1);
    await owner.query("UPDATE scheduled_deliveries SET status='cancelled',cancelled_at=now(),cancellation_reason='Subscription removed',updated_at=now() WHERE id=$1", [afterCancellation.items[0]?.id]);
    const empty = await transactions.run(value.vendorId, (tx) => scheduledDeliveries.listSelf(tx, value.vendorId, value.membershipId, '2030-01-01', {}));
    assert.equal(empty.items.length, 0);
  } finally { await cleanup([value]); }
});

void test('agent HTTP is exact-self scoped and returns only the safe scheduled-stop DTO', async () => {
  const own = await fixture('agent-http'); const other = await fixture('agent-other');
  try {
    await owner.query("UPDATE households SET address_line_2='Floor 2',locality='Camp',updated_at=now() WHERE vendor_id=$1 AND id=$2", [own.vendorId, own.householdId]);
    const inserted = (await insert(own)).rows[0].id;
    const path = `/v1/agent/vendors/${own.vendorId}/scheduled-deliveries?serviceDate=2030-01-01`;
    const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${own.agentToken}` } });
    assert.equal(response.status, 200); const body = await response.json() as { serviceDate: string; items: Array<Record<string, unknown>> };
    assert.equal(body.serviceDate, '2030-01-01');
    assert.equal(body.items[0]?.id, inserted);
    assert.deepEqual(Object.keys(body.items[0]).sort(), [
      'addressLine1','addressLine2','blockedByCustomerLeave','captureLocationEvidence','city','countryCode','currentStatus','deliverySlotEndLocalTime','deliverySlotId',
      'deliverySlotName','deliverySlotStartLocalTime','householdAccountNumber','householdId','householdName',
      'id','locality','pendingStopItems','plannedQuantity','postalCode','productCode','productId','productName','region',
      'routeAssignmentId','routeCode','routeId','routeName','routeStopId','sequence','serviceDate',
      'subscriptionId','unitCode','unitId','unitName','version',
    ]);
    assert.equal(body.items[0]?.addressLine2, 'Floor 2');
    assert.equal(body.items[0]?.locality, 'Camp');
    assert.equal(body.items[0]?.currentStatus, 'scheduled');
    assert.equal(body.items[0]?.blockedByCustomerLeave, false);
    const pending = body.items[0]?.pendingStopItems as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(pending[0]).sort(), ['expectedVersion','plannedQuantity','productName','scheduledDeliveryId','unitName']);
    assert.equal(pending[0]?.scheduledDeliveryId, inserted);
    for (const forbidden of ['customerPhone','householdNotes','billingDetails','sourcePriceId','amountMinor','latitude','longitude','note']) {
      assert.equal(forbidden in body.items[0], false);
      assert.equal(forbidden in pending[0], false);
    }
    const foreign = await fetch(`${baseUrl}/v1/agent/vendors/${other.vendorId}/scheduled-deliveries?serviceDate=2030-01-01`, { headers: { authorization: `Bearer ${own.agentToken}` } });
    assert.equal(foreign.status, 403);
    const ownerDenied = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${own.ownerToken}` } });
    assert.equal(ownerDenied.status, 403);
  } finally { await cleanup([own, other]); }
});

void test('batch schedule pricing applies vendor-local slot boundaries, override scope, global fallback, and missing status', async () => {
  const value = await fixture('pricing-batch');
  const pricing = app.get(SchedulingPriceService);
  const candidate = {
    subscriptionId: value.subscriptionId,
    householdId: value.householdId,
    productId: value.productId,
    unitId: value.unitId,
    deliverySlotId: value.slotId,
  };
  const resolve = (householdId = value.householdId) => transactions.run(value.vendorId, (tx) =>
    pricing.resolveMany(tx, value.vendorId, '2030-01-01', [{ ...candidate, householdId }]));
  try {
    assert.equal((await resolve())[0]?.status, 'resolved');
    await owner.query('DELETE FROM global_prices WHERE vendor_id=$1', [value.vendorId]);
    assert.equal((await resolve())[0]?.status, 'missing');
    const overrideId = randomUUID();
    // The fixture's 06:00 Asia/Kolkata slot starts at 00:30 UTC; price periods are half-open.
    await owner.query(
      "INSERT INTO customer_price_overrides(id,vendor_id,household_id,product_id,unit_id,amount_minor,currency,effective_from,reason,created_by,updated_at) VALUES($1,$2,$3,$4,$5,90,'INR','2030-01-01T00:30:00Z','Schedule boundary',$6,now())",
      [overrideId, value.vendorId, value.householdId, value.productId, value.unitId, value.userId],
    );
    const batch = await transactions.run(value.vendorId, (tx) => pricing.resolveMany(tx, value.vendorId, '2030-01-01', [
      candidate, { ...candidate, subscriptionId: randomUUID(), householdId: value.otherHouseholdId },
    ]));
    assert.equal(batch.length, 2);
    assert.equal(batch.find(({ householdId }) => householdId === value.householdId)?.status, 'resolved');
    assert.equal(batch.find(({ householdId }) => householdId === value.otherHouseholdId)?.status, 'missing');
    await owner.query(
      "UPDATE customer_price_overrides SET effective_from='2029-12-31T00:30:00Z',effective_to='2030-01-01T00:30:00Z',updated_at=now() WHERE id=$1",
      [overrideId],
    );
    assert.equal((await resolve())[0]?.status, 'missing');
  } finally { await cleanup([value]); }
});

void test('generator waits for a concurrent subscription mutation and persists its committed projection', { timeout: 10000 }, async () => {
  const value = await fixture('subscription-race');
  const serviceDate = DateTime.now().setZone('Asia/Kolkata').plus({ days: 1 }).toISODate()!;
  const { weekday } = await moveFixtureToDate(value, serviceDate);
  try {
    await generateAfterQueuedMutation(value, serviceDate, () => fetch(`${baseUrl}/v1/vendors/${value.vendorId}/subscriptions/${value.subscriptionId}/modify`, {
      method: 'POST', headers: { authorization: `Bearer ${value.ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ productId: value.productId, unitId: value.unitId, deliverySlotId: value.slotId, quantity: '2', weekdays: [weekday], effectiveDate: serviceDate, expectedVersion: 1, reason: 'Concurrent quantity change' }),
    }));
    const persisted = await owner.query<{ quantity: string }>('SELECT planned_quantity::text quantity FROM scheduled_deliveries WHERE vendor_id=$1 AND service_date=$2', [value.vendorId, serviceDate]);
    assert.deepEqual(persisted.rows, [{ quantity: '2.000' }]);
  } finally { await cleanup([value]); }
});

void test('generator waits for a concurrent routing mutation and persists its committed projection', { timeout: 10000 }, async () => {
  const value = await fixture('routing-race');
  const serviceDate = DateTime.now().setZone('Asia/Kolkata').plus({ days: 1 }).toISODate()!;
  await moveFixtureToDate(value, serviceDate);
  try {
    await generateAfterQueuedMutation(value, serviceDate, () => fetch(`${baseUrl}/v1/vendors/${value.vendorId}/routes/${value.routeId}/assignments/${serviceDate}/cancel`, {
      method: 'POST', headers: { authorization: `Bearer ${value.ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, reason: 'Concurrent route cancellation' }),
    }));
    const persisted = await owner.query<{ routeAssignmentId: string | null }>('SELECT route_assignment_id AS "routeAssignmentId" FROM scheduled_deliveries WHERE vendor_id=$1 AND service_date=$2', [value.vendorId, serviceDate]);
    assert.deepEqual(persisted.rows, [{ routeAssignmentId: null }]);
  } finally { await cleanup([value]); }
});

void test('generator/store counts first run, rerun, update, unassignment, cancellation, reactivation, and finalized immutability', async () => {
  const value = await fixture('generator'); const runner = app.get(TenantTransactionRunner); const generator = app.get(ScheduleGenerator);
  const generate = () => runner.run(value.vendorId, (tx) => generator.generate(tx, value.vendorId, '2030-01-01'));
  try {
    assert.deepEqual(await generate(), { created: 1, existing: 0, updated: 0, cancelled: 0, missingPrice: 0 });
    assert.deepEqual(await generate(), { created: 0, existing: 1, updated: 0, cancelled: 0, missingPrice: 0 });
    await owner.query('UPDATE subscription_revisions SET quantity=2,updated_at=now() WHERE id=$1', [value.revisionId]);
    assert.equal((await generate()).updated, 1);
    await owner.query("UPDATE route_assignments SET status='cancelled',cancelled_at=now(),cancellation_reason='No agent today',updated_at=now() WHERE id=$1", [value.assignmentId]);
    assert.equal((await generate()).updated, 1);
    await owner.query("UPDATE subscription_revisions SET status='paused',updated_at=now() WHERE id=$1", [value.revisionId]);
    assert.equal((await generate()).cancelled, 1);
    await owner.query("UPDATE subscription_revisions SET status='active',updated_at=now() WHERE id=$1", [value.revisionId]);
    assert.equal((await generate()).updated, 1);
    await owner.query('UPDATE scheduled_deliveries SET finalized_at=now() WHERE vendor_id=$1', [value.vendorId]);
    await owner.query('UPDATE subscription_revisions SET quantity=3,updated_at=now() WHERE id=$1', [value.revisionId]);
    assert.deepEqual(await generate(), { created: 0, existing: 1, updated: 0, cancelled: 0, missingPrice: 0 });
    const persisted = await owner.query<{ version: number; quantity: string }>('SELECT version,planned_quantity::text quantity FROM scheduled_deliveries WHERE vendor_id=$1', [value.vendorId]);
    assert.deepEqual(persisted.rows, [{ version: 5, quantity: '2.000' }]);
  } finally { await cleanup([value]); }
});

void test('slot-change reconciliation rolls back its replacement when old-row cancellation fails', async () => {
  const value = await fixture('slot-change-rollback');
  const generator = app.get(ScheduleGenerator);
  const suffix = randomUUID().replaceAll('-', '');
  const trigger = `reject_old_schedule_cancellation_${suffix}`;
  const triggerFunction = `reject_old_schedule_cancellation_fn_${suffix}`;
  const generate = () => transactions.run(value.vendorId, (tx) =>
    generator.generate(tx, value.vendorId, '2030-01-01'));
  try {
    assert.equal((await generate()).created, 1);
    await owner.query(
      "UPDATE subscription_revisions SET effective_from='2029-12-31',effective_to='2030-01-01',updated_at=now() WHERE id=$1",
      [value.revisionId],
    );
    await owner.query(
      "UPDATE subscription_revisions SET effective_from='2030-01-01',updated_at=now() WHERE id=$1",
      [value.otherRevisionId],
    );
    await owner.query(
      'UPDATE subscription_revision_weekdays SET weekday=2 WHERE subscription_revision_id=$1',
      [value.otherRevisionId],
    );
    const original = await owner.query<{
      id: string; subscriptionId: string; revisionId: string; householdId: string;
      productId: string; unitId: string; deliverySlotId: string; routeAssignmentId: string | null;
      serviceDate: string; plannedQuantity: string; status: string; version: number;
    }>(`SELECT id,subscription_id AS "subscriptionId",subscription_revision_id AS "revisionId",
      household_id AS "householdId",product_id AS "productId",unit_id AS "unitId",
      delivery_slot_id AS "deliverySlotId",route_assignment_id AS "routeAssignmentId",
      service_date::text AS "serviceDate",planned_quantity::text AS "plannedQuantity",status,version
      FROM scheduled_deliveries WHERE vendor_id=$1 AND service_date='2030-01-01'`, [value.vendorId]);
    assert.equal(original.rowCount, 1);

    await owner.query(`CREATE FUNCTION ${triggerFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id='${original.rows[0].id}'::uuid AND NEW.status='cancelled' THEN
          IF NOT EXISTS (
            SELECT 1 FROM scheduled_deliveries
            WHERE vendor_id='${value.vendorId}'::uuid AND subscription_id='${value.subscriptionId}'::uuid
              AND service_date='2030-01-01' AND delivery_slot_id='${value.otherSlotId}'::uuid
          ) THEN
            RAISE EXCEPTION 'replacement row was not inserted before cancellation';
          END IF;
          RAISE EXCEPTION 'forced old-row cancellation failure';
        END IF;
        RETURN NEW;
      END $$`);
    await owner.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON scheduled_deliveries
      FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}()`);

    await assert.rejects(generate(), /forced old-row cancellation failure/);

    const persisted = await owner.query<typeof original.rows[number]>(`SELECT id,subscription_id AS "subscriptionId",
      subscription_revision_id AS "revisionId",household_id AS "householdId",product_id AS "productId",
      unit_id AS "unitId",delivery_slot_id AS "deliverySlotId",route_assignment_id AS "routeAssignmentId",
      service_date::text AS "serviceDate",planned_quantity::text AS "plannedQuantity",status,version
      FROM scheduled_deliveries WHERE vendor_id=$1 AND service_date='2030-01-01'`, [value.vendorId]);
    assert.deepEqual(persisted.rows, original.rows);
  } finally {
    await owner.query(`DROP TRIGGER IF EXISTS ${trigger} ON scheduled_deliveries`);
    await owner.query(`DROP FUNCTION IF EXISTS ${triggerFunction}()`);
    await cleanup([value]);
  }
});

void test('concurrent repeated generators remain duplicate-safe', { timeout: 5000 }, async () => {
  const value = await fixture('generator-race'); const runner = app.get(TenantTransactionRunner); const generator = app.get(ScheduleGenerator);
  try {
    const results = await Promise.all([1, 2].map(() => runner.run(value.vendorId, (tx) => generator.generate(tx, value.vendorId, '2030-01-01'))));
    assert.deepEqual(results.map(({ created, existing }) => [created, existing]).sort(), [[0, 1], [1, 0]]);
    assert.equal((await owner.query('SELECT id FROM scheduled_deliveries WHERE vendor_id=$1', [value.vendorId])).rowCount, 1);
  } finally { await cleanup([value]); }
});
