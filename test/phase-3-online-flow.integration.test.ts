import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import test from 'node:test';

import type { INestApplication } from '@nestjs/common';
import { DateTime } from 'luxon';
import pg from 'pg';

const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
const authKey = Buffer.from(process.env.AUTH_HMAC_KEY!, 'base64');
let app: INestApplication;
let baseUrl = '';

test.before(async () => {
  const { createApp } = await import('../src/bootstrap/create-app.js');
  app = await createApp({ logger: false });
  await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as Server).address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});
test.after(() => Promise.all([app.close(), owner.end()]));

const hash = (token: string) => createHmac('sha256', authKey).update(token).digest('hex');

async function session(userId: string, method: 'administrator_mfa' | 'phone_otp') {
  const token = randomUUID();
  await owner.query(`INSERT INTO sessions
    (id,user_id,access_token_hash,refresh_token_hash,authentication_method,device_id,access_expires_at,expires_at,last_seen_at)
    VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now()+interval '1 day',now())`,
  [randomUUID(), userId, hash(token), hash(randomUUID()), method, `p3-${userId}`]);
  return token;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const now = DateTime.now().setZone('Asia/Kolkata');
  const lateDate = now.plus({ days: 1 }).toISODate()!;
  const onTimeDate = now.plus({ days: 10 }).toISODate()!;
  const skipDate = now.plus({ days: 11 }).toISODate()!;
  const longStartDate = now.plus({ days: 30 }).toISODate()!;
  const longEndDate = now.plus({ days: 30, years: 100 }).toISODate()!;
  const value = {
    vendorId: randomUUID(), foreignVendorId: randomUUID(), householdId: randomUUID(), foreignHouseholdId: randomUUID(),
    customerId: randomUUID(), foreignCustomerId: randomUUID(), ownerId: randomUUID(), foreignOwnerId: randomUUID(),
    agentId: randomUUID(), foreignAgentId: randomUUID(), platformId: randomUUID(),
    customerMembershipId: randomUUID(), ownerMembershipId: randomUUID(), agentMembershipId: randomUUID(),
    foreignCustomerMembershipId: randomUUID(), foreignOwnerMembershipId: randomUUID(), foreignAgentMembershipId: randomUUID(),
    unitId: randomUUID(), productId: randomUUID(), slotId: randomUUID(), routeId: randomUUID(), planId: randomUUID(), stopId: randomUUID(),
    leaveSubscriptionId: randomUUID(), leaveRevisionId: randomUUID(), activeSubscriptionId: randomUUID(), activeRevisionId: randomUUID(),
    longSubscriptionId: randomUUID(), longRevisionId: randomUUID(),
    lateDeliveryId: randomUUID(), leaveDeliveryId: randomUUID(), remainingLeaveDeliveryId: randomUUID(), deliveredId: randomUUID(), skippedId: randomUUID(),
    longFirstDeliveryId: randomUUID(), longLastDeliveryId: randomUUID(),
    overrideId: randomUUID(), globalPriceId: randomUUID(), lateDate, onTimeDate, skipDate, longStartDate, longEndDate,
  };
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    for (const [id, name] of [
      [value.customerId, 'Phase 3 Customer'], [value.foreignCustomerId, 'Foreign Customer'], [value.ownerId, 'Phase 3 Owner'],
      [value.foreignOwnerId, 'Foreign Owner'], [value.agentId, 'Phase 3 Agent'], [value.foreignAgentId, 'Foreign Agent'],
      [value.platformId, 'Platform Support'],
    ]) await client.query('INSERT INTO users(id,display_name,updated_at) VALUES($1,$2,now())', [id, name]);
    for (const [userId, phone] of [
      [value.customerId, '+919000000001'], [value.foreignCustomerId, '+919000000002'],
    ]) await client.query("INSERT INTO user_identities(id,user_id,type,normalized_value,verified_at,is_primary,updated_at) VALUES($1,$2,'phone',$3,now(),true,now())", [randomUUID(), userId, phone]);
    await client.query(`INSERT INTO vendors
      (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,late_leave_policy,billing_day,updated_at)
      VALUES($1,$2,$3,$3,'active','Asia/Kolkata','INR',10080,'approval',1,now()),
            ($4,$5,$6,$6,'active','Asia/Kolkata','INR',60,'approval',1,now())`,
    [value.vendorId, `p3-a-${value.vendorId}`, 'Phase 3 Vendor A', value.foreignVendorId, `p3-b-${value.foreignVendorId}`, 'Phase 3 Vendor B']);
    for (const [id, vendorId, userId, role] of [
      [value.customerMembershipId, value.vendorId, value.customerId, 'customer'], [value.ownerMembershipId, value.vendorId, value.ownerId, 'vendor_owner'],
      [value.agentMembershipId, value.vendorId, value.agentId, 'delivery_agent'], [value.foreignCustomerMembershipId, value.foreignVendorId, value.foreignCustomerId, 'customer'],
      [value.foreignOwnerMembershipId, value.foreignVendorId, value.foreignOwnerId, 'vendor_owner'], [value.foreignAgentMembershipId, value.foreignVendorId, value.foreignAgentId, 'delivery_agent'],
    ]) await client.query("INSERT INTO vendor_memberships(id,vendor_id,user_id,role,status,joined_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())", [id, vendorId, userId, role]);
    await client.query("INSERT INTO mfa_factors(id,user_id,type,encrypted_secret,enabled_at) VALUES($1,$2,'totp','p3',now()),($3,$4,'totp','p3',now()),($5,$6,'totp','p3',now())", [randomUUID(), value.ownerId, randomUUID(), value.foreignOwnerId, randomUUID(), value.platformId]);
    await client.query("INSERT INTO platform_role_assignments(id,user_id,role,granted_by) VALUES($1,$2,'support_operations',$2)", [randomUUID(), value.platformId]);
    await client.query(`INSERT INTO support_access_grants
      (id,vendor_id,grantee_user_id,requested_by,approved_by,purpose,scope_json,access_mode,starts_at,expires_at)
      VALUES($1,$2,$3,$3,$3,'Phase 3 acceptance','["schedule:read"]'::jsonb,'read',now()-interval '1 minute',now()+interval '1 hour')`,
    [randomUUID(), value.vendorId, value.platformId]);
    await client.query(`INSERT INTO households(id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at)
      VALUES($1,$2,'P3-A','Phase 3 Household','1 Milk Road','Pune','MH','411001','IN',now()),
            ($3,$4,'P3-B','Foreign Household','2 Milk Road','Pune','MH','411001','IN',now())`,
    [value.householdId, value.vendorId, value.foreignHouseholdId, value.foreignVendorId]);
    await client.query("INSERT INTO household_members(id,vendor_id,household_id,customer_membership_id,status,joined_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now()),($5,$6,$7,$8,'active',now(),now())", [randomUUID(), value.vendorId, value.householdId, value.customerMembershipId, randomUUID(), value.foreignVendorId, value.foreignHouseholdId, value.foreignCustomerMembershipId]);
    await client.query("INSERT INTO units(id,vendor_id,code,name,decimal_scale,updated_at) VALUES($1,$2,'LITRE','Litre',3,now())", [value.unitId, value.vendorId]);
    await client.query("INSERT INTO products(id,vendor_id,code,name,default_unit_id,updated_at) VALUES($1,$2,'MILK','Milk',$3,now())", [value.productId, value.vendorId, value.unitId]);
    await client.query("INSERT INTO delivery_slots(id,vendor_id,code,name,start_local_time,end_local_time,updated_at) VALUES($1,$2,'AM','Morning','06:00','09:00',now())", [value.slotId, value.vendorId]);
    await client.query(`INSERT INTO global_prices(id,vendor_id,product_id,unit_id,amount_minor,currency,effective_from,created_by,updated_at)
      VALUES($1,$2,$3,$4,100,'INR',now()-interval '1 day',$5,now())`, [value.globalPriceId, value.vendorId, value.productId, value.unitId, value.ownerId]);
    await client.query(`INSERT INTO customer_price_overrides(id,vendor_id,household_id,product_id,unit_id,amount_minor,currency,effective_from,reason,created_by,updated_at)
      VALUES($1,$2,$3,$4,$5,95,'INR',now()-interval '1 day','Phase 3 contract',$6,now())`, [value.overrideId, value.vendorId, value.householdId, value.productId, value.unitId, value.ownerId]);
    for (const [subscriptionId, revisionId] of [[value.leaveSubscriptionId, value.leaveRevisionId], [value.activeSubscriptionId, value.activeRevisionId]]) {
      await client.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [subscriptionId, value.vendorId, value.householdId]);
      await client.query(`INSERT INTO subscription_revisions
        (id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,effective_to,created_by,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,1.25,'active',$7::date-1,$8::date+2,$9,now())`,
      [revisionId, value.vendorId, subscriptionId, value.productId, value.unitId, value.slotId, value.lateDate, value.skipDate, value.ownerId]);
    }
    await client.query('INSERT INTO subscriptions(id,vendor_id,household_id,updated_at) VALUES($1,$2,$3,now())', [value.longSubscriptionId, value.vendorId, value.householdId]);
    await client.query(`INSERT INTO subscription_revisions
      (id,vendor_id,subscription_id,product_id,unit_id,delivery_slot_id,quantity,status,effective_from,effective_to,created_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,1.25,'active',$7::date-1,$8::date+1,$9,now())`,
    [value.longRevisionId, value.vendorId, value.longSubscriptionId, value.productId, value.unitId, value.slotId, value.longStartDate, value.longEndDate, value.ownerId]);
    for (const weekday of new Set([DateTime.fromISO(value.lateDate).weekday, DateTime.fromISO(value.onTimeDate).weekday, DateTime.fromISO(value.skipDate).weekday])) {
      await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,$3)', [value.vendorId, value.leaveRevisionId, weekday]);
    }
    await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,$3)', [value.vendorId, value.activeRevisionId, DateTime.fromISO(value.onTimeDate).weekday]);
    for (const weekday of new Set([DateTime.fromISO(value.longStartDate).weekday, DateTime.fromISO(value.longEndDate).weekday])) {
      await client.query('INSERT INTO subscription_revision_weekdays(vendor_id,subscription_revision_id,weekday) VALUES($1,$2,$3)', [value.vendorId, value.longRevisionId, weekday]);
    }
    await client.query('INSERT INTO routes(id,vendor_id,code,name,delivery_slot_id,updated_at) VALUES($1,$2,$3,$4,$5,now())', [value.routeId, value.vendorId, `P3_${value.routeId.slice(0, 8).toUpperCase()}`, 'Phase 3 Route', value.slotId]);
    await client.query('INSERT INTO route_stop_plans(id,vendor_id,route_id,delivery_slot_id,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,now())', [value.planId, value.vendorId, value.routeId, value.slotId, value.lateDate, value.ownerId]);
    await client.query('INSERT INTO route_stops(id,vendor_id,route_id,plan_id,household_id,delivery_slot_id,sequence,effective_from,created_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,now())', [value.stopId, value.vendorId, value.routeId, value.planId, value.householdId, value.slotId, value.lateDate, value.ownerId]);
    const assignments = new Map<string, string>();
    for (const serviceDate of [value.lateDate, value.onTimeDate, value.skipDate]) {
      const id = randomUUID(); assignments.set(serviceDate, id);
      await client.query(`INSERT INTO route_assignments(id,vendor_id,route_id,delivery_slot_id,agent_membership_id,service_date,created_by,updated_by,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7,now())`, [id, value.vendorId, value.routeId, value.slotId, value.agentMembershipId, serviceDate, value.ownerId]);
    }
    for (const [id, subscriptionId, revisionId, serviceDate] of [
      [value.lateDeliveryId, value.leaveSubscriptionId, value.leaveRevisionId, value.lateDate],
      [value.leaveDeliveryId, value.leaveSubscriptionId, value.leaveRevisionId, value.onTimeDate],
      [value.remainingLeaveDeliveryId, value.leaveSubscriptionId, value.leaveRevisionId, value.skipDate],
      [value.deliveredId, value.activeSubscriptionId, value.activeRevisionId, value.onTimeDate],
      [value.skippedId, value.activeSubscriptionId, value.activeRevisionId, value.skipDate],
    ]) await client.query(`INSERT INTO scheduled_deliveries
      (id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,delivery_slot_id,route_assignment_id,service_date,planned_quantity,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1.25,now())`,
    [id, value.vendorId, subscriptionId, revisionId, value.householdId, value.productId, value.unitId, value.slotId, assignments.get(serviceDate), serviceDate]);
    for (const [id, serviceDate] of [[value.longFirstDeliveryId, value.longStartDate], [value.longLastDeliveryId, value.longEndDate]]) {
      await client.query(`INSERT INTO scheduled_deliveries
        (id,vendor_id,subscription_id,subscription_revision_id,household_id,product_id,unit_id,delivery_slot_id,service_date,planned_quantity,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1.25,now())`,
      [id, value.vendorId, value.longSubscriptionId, value.longRevisionId, value.householdId, value.productId, value.unitId, value.slotId, serviceDate]);
    }
    await client.query('COMMIT');
    return {
      ...value,
      customerToken: await session(value.customerId, 'phone_otp'), ownerToken: await session(value.ownerId, 'administrator_mfa'), agentToken: await session(value.agentId, 'phone_otp'),
      foreignCustomerToken: await session(value.foreignCustomerId, 'phone_otp'), foreignOwnerToken: await session(value.foreignOwnerId, 'administrator_mfa'),
      foreignAgentToken: await session(value.foreignAgentId, 'phone_otp'), platformToken: await session(value.platformId, 'administrator_mfa'),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(value: Fixture) {
  const vendors = [value.vendorId, value.foreignVendorId];
  const users = [value.customerId, value.foreignCustomerId, value.ownerId, value.foreignOwnerId, value.agentId, value.foreignAgentId, value.platformId];
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query('DELETE FROM support_access_grants WHERE vendor_id=ANY($1::uuid[])', [vendors]);
    for (const table of ['notifications', 'delivery_price_snapshots', 'delivery_events', 'scheduled_deliveries']) await client.query(`DELETE FROM ${table} WHERE vendor_id=ANY($1::uuid[])`, [vendors]);
    await client.query('UPDATE leave_requests SET current_revision_id=NULL WHERE vendor_id=ANY($1::uuid[])', [vendors]);
    for (const table of ['leave_occurrence_decisions', 'leave_revision_subscriptions', 'leave_request_revisions', 'leave_requests', 'audit_events', 'route_stops', 'route_stop_plans', 'route_assignments', 'routes', 'subscription_revision_weekdays', 'subscription_revisions', 'subscriptions', 'customer_price_overrides', 'global_prices', 'household_members', 'vendor_memberships', 'delivery_slots', 'products', 'units', 'households']) await client.query(`DELETE FROM ${table} WHERE vendor_id=ANY($1::uuid[])`, [vendors]);
    await client.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [users]);
    await client.query('DELETE FROM mfa_factors WHERE user_id=ANY($1::uuid[])', [users]);
    await client.query('DELETE FROM platform_role_assignments WHERE user_id=ANY($1::uuid[])', [users]);
    await client.query('DELETE FROM user_identities WHERE user_id=ANY($1::uuid[])', [users]);
    await client.query('DELETE FROM vendors WHERE id=ANY($1::uuid[])', [vendors]);
    await client.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function api(path: string, token: string, options: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, { method: options.method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as T;
}

void test('public HTTP completes mixed leave, atomic delivery, correction, privacy, and tenant-denial flow', async () => {
  const value = await fixture();
  const customerBase = `/customer/vendors/${value.vendorId}/households/${value.householdId}`;
  try {
    const selection = { startDate: value.onTimeDate, endDate: value.skipDate, subscriptionIds: [value.leaveSubscriptionId], limit: 1 };
    const beforePreview = await owner.query<{ count: number }>('SELECT count(*)::int count FROM leave_requests WHERE vendor_id=$1', [value.vendorId]);
    const preview = await json<{ timezone: string; lateLeavePolicy: string; onTimeCount: number; lateCount: number; items: unknown[]; nextCursor?: string }>(
      await api(`${customerBase}/leave-requests/preview`, value.customerToken, { method: 'POST', body: selection }), 200);
    assert.equal(preview.timezone, 'Asia/Kolkata'); assert.equal(preview.lateLeavePolicy, 'approval');
    assert.equal(preview.onTimeCount, 2); assert.equal(preview.lateCount, 0); assert.equal(preview.items.length, 1); assert.ok(preview.nextCursor);
    assert.equal((await owner.query<{ count: number }>('SELECT count(*)::int count FROM leave_requests WHERE vendor_id=$1', [value.vendorId])).rows[0]?.count, beforePreview.rows[0]?.count);

    const leave = await json<{ id: string; currentStatus: string; version: number }>(await api(`${customerBase}/leave-requests`, value.customerToken, {
      method: 'POST', body: { startDate: value.onTimeDate, endDate: value.skipDate, subscriptionIds: [value.leaveSubscriptionId] },
    }), 201);
    assert.equal(leave.currentStatus, 'accepted');
    assert.deepEqual((await owner.query<{ id: string; status: string }>('SELECT id,status FROM scheduled_deliveries WHERE id=ANY($1::uuid[]) ORDER BY id', [[value.leaveDeliveryId, value.remainingLeaveDeliveryId]])).rows,
      [{ id: value.leaveDeliveryId, status: 'skipped_by_customer' }, { id: value.remainingLeaveDeliveryId, status: 'skipped_by_customer' }].sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal((await owner.query('SELECT 1 FROM delivery_price_snapshots WHERE scheduled_delivery_id=$1', [value.leaveDeliveryId])).rowCount, 0);
    await owner.query('UPDATE vendors SET skip_cutoff_minutes=20160 WHERE id=$1', [value.vendorId]);
    const amended = await json<{ currentStatus: string; version: number; currentRevisionId: string }>(await api(`${customerBase}/leave-requests/${leave.id}/amendments`, value.customerToken, {
      method: 'POST', body: { startDate: value.skipDate, endDate: value.skipDate, subscriptionIds: [value.leaveSubscriptionId], expectedVersion: leave.version },
    }), 200);
    assert.equal(amended.currentStatus, 'partially_pending');
    assert.deepEqual((await owner.query<{ id: string; status: string }>('SELECT id,status FROM scheduled_deliveries WHERE id=ANY($1::uuid[]) ORDER BY id', [[value.leaveDeliveryId, value.remainingLeaveDeliveryId]])).rows,
      [{ id: value.leaveDeliveryId, status: 'skipped_by_customer' }, { id: value.remainingLeaveDeliveryId, status: 'skipped_by_customer' }].sort((a, b) => a.id.localeCompare(b.id)));
    const removalDecision = (await owner.query<{ id: string; version: number }>("SELECT id,version FROM leave_occurrence_decisions WHERE vendor_id=$1 AND leave_request_revision_id=$2 AND service_date=$3 AND status='pending'", [value.vendorId, amended.currentRevisionId, value.onTimeDate])).rows[0];
    assert.ok(removalDecision);
    const approved = await json<{ request: { currentStatus: string; version: number } }>(await api(`/vendors/${value.vendorId}/leave-occurrence-decisions/${removalDecision.id}/decision`, value.ownerToken, {
      method: 'POST', body: { expectedVersion: removalDecision.version, decision: 'approved', reason: 'Approve leave removal' },
    }), 200);
    assert.equal(approved.request.currentStatus, 'accepted');
    const reversalEvents = (await owner.query<{ id: string; eventType: string; replacedEventId: string | null }>(`SELECT id,event_type AS "eventType",replaced_event_id AS "replacedEventId"
      FROM delivery_events WHERE vendor_id=$1 AND scheduled_delivery_id=$2 ORDER BY created_at,id`, [value.vendorId, value.leaveDeliveryId])).rows;
    assert.deepEqual(reversalEvents.map(({ eventType }) => eventType), ['skipped_by_customer', 'scheduled']);
    assert.equal(reversalEvents[1]?.replacedEventId, reversalEvents[0]?.id);

    const cancelled = await json<{ currentStatus: string; currentRevisionId: string }>(await api(`${customerBase}/leave-requests/${leave.id}/cancellations`, value.customerToken, {
      method: 'POST', body: { expectedVersion: approved.request.version },
    }), 200);
    assert.equal(cancelled.currentStatus, 'pending_approval');
    const cancellationDecision = (await owner.query<{ id: string; version: number }>("SELECT id,version FROM leave_occurrence_decisions WHERE vendor_id=$1 AND leave_request_revision_id=$2 AND service_date=$3 AND status='pending'", [value.vendorId, cancelled.currentRevisionId, value.skipDate])).rows[0];
    assert.ok(cancellationDecision);
    const rejectedCancellation = await json<{ request: { currentStatus: string } }>(await api(`/vendors/${value.vendorId}/leave-occurrence-decisions/${cancellationDecision.id}/decision`, value.ownerToken, {
      method: 'POST', body: { expectedVersion: cancellationDecision.version, decision: 'rejected', reason: 'Keep remaining leave' },
    }), 200);
    assert.equal(rejectedCancellation.request.currentStatus, 'accepted');
    assert.deepEqual((await owner.query('SELECT status FROM scheduled_deliveries WHERE id=$1', [value.remainingLeaveDeliveryId])).rows, [{ status: 'skipped_by_customer' }]);

    const writeState = async () => (await owner.query<{ state: unknown }>(`SELECT jsonb_build_object(
      'leaveRequests',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'version',version,'currentRevisionId',current_revision_id) ORDER BY id) FROM leave_requests WHERE vendor_id=$1),'[]'::jsonb),
      'revisions',(SELECT count(*)::int FROM leave_request_revisions WHERE vendor_id=$1),
      'decisions',(SELECT count(*)::int FROM leave_occurrence_decisions WHERE vendor_id=$1),
      'events',(SELECT count(*)::int FROM delivery_events WHERE vendor_id=$1),
      'notifications',(SELECT count(*)::int FROM notifications WHERE vendor_id=$1),
      'audits',(SELECT count(*)::int FROM audit_events WHERE vendor_id=$1),
      'scheduledDeliveries',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'version',version) ORDER BY id) FROM scheduled_deliveries WHERE vendor_id=$1),'[]'::jsonb),
      'priceSnapshots',(SELECT count(*)::int FROM delivery_price_snapshots WHERE vendor_id=$1)) AS state`, [value.vendorId])).rows[0]?.state;
    const beforeOverlap = await writeState();
    const overlap = await json<{ code: string }>(await api(`${customerBase}/leave-requests/preview`, value.customerToken, {
      method: 'POST', body: { startDate: value.skipDate, endDate: value.skipDate, subscriptionIds: [value.leaveSubscriptionId] },
    }), 409);
    assert.equal(overlap.code, 'LEAVE_OVERLAP');
    assert.deepEqual(await writeState(), beforeOverlap);

    const scheduledCount = (await owner.query<{ count: number }>('SELECT count(*)::int count FROM scheduled_deliveries WHERE vendor_id=$1', [value.vendorId])).rows[0]?.count;
    const longLeave = await json<{ currentStatus: string }>(await api(`${customerBase}/leave-requests`, value.customerToken, {
      method: 'POST', body: { startDate: value.longStartDate, endDate: value.longEndDate, subscriptionIds: [value.longSubscriptionId] },
    }), 201);
    assert.equal(longLeave.currentStatus, 'accepted');
    assert.equal((await owner.query<{ count: number }>('SELECT count(*)::int count FROM scheduled_deliveries WHERE vendor_id=$1', [value.vendorId])).rows[0]?.count, scheduledCount);
    assert.deepEqual((await owner.query<{ id: string; status: string }>('SELECT id,status FROM scheduled_deliveries WHERE id=ANY($1::uuid[]) ORDER BY id', [[value.longFirstDeliveryId, value.longLastDeliveryId]])).rows,
      [{ id: value.longFirstDeliveryId, status: 'skipped_by_customer' }, { id: value.longLastDeliveryId, status: 'skipped_by_customer' }].sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal((await owner.query<{ count: number }>('SELECT count(*)::int count FROM delivery_events WHERE scheduled_delivery_id=ANY($1::uuid[])', [[value.longFirstDeliveryId, value.longLastDeliveryId]])).rows[0]?.count, 2);

    const supportDetail = await api(`/vendors/${value.vendorId}/leave-requests/${leave.id}`, value.platformToken);
    assert.equal(supportDetail.status, 403, await supportDetail.text());

    const schedule = await json<{ items: Array<{ id: string; blockedByCustomerLeave: boolean; pendingStopItems: Array<{ scheduledDeliveryId: string; expectedVersion: number }> }> }>(
      await api(`/agent/vendors/${value.vendorId}/scheduled-deliveries?serviceDate=${value.skipDate}`, value.agentToken), 200);
    const blocked = schedule.items.find(({ id }) => id === value.remainingLeaveDeliveryId); const actionable = schedule.items.find(({ id }) => id === value.skippedId);
    assert.equal(blocked?.blockedByCustomerLeave, true); assert(!blocked?.pendingStopItems.some(({ scheduledDeliveryId }) => scheduledDeliveryId === value.remainingLeaveDeliveryId));
    assert.ok(actionable?.pendingStopItems.some(({ scheduledDeliveryId }) => scheduledDeliveryId === value.skippedId));

    const eventCount = Number((await owner.query<{ count: string }>('SELECT count(*) count FROM delivery_events WHERE scheduled_delivery_id=$1', [value.remainingLeaveDeliveryId])).rows[0]?.count);
    const blockedAttempt = await api(`/agent/vendors/${value.vendorId}/route-stops/${value.stopId}/outcomes`, value.agentToken, {
      method: 'POST', body: { serviceDate: value.skipDate, outcome: 'delivered', occurredAt: new Date().toISOString(), items: [{ scheduledDeliveryId: value.remainingLeaveDeliveryId, expectedVersion: 2, actualQuantity: '1' }] },
    });
    assert.equal(blockedAttempt.status, 409); assert.equal(Number((await owner.query<{ count: string }>('SELECT count(*) count FROM delivery_events WHERE scheduled_delivery_id=$1', [value.remainingLeaveDeliveryId])).rows[0]?.count), eventCount);
    assert.equal((await owner.query('SELECT 1 FROM delivery_price_snapshots WHERE scheduled_delivery_id=$1', [value.remainingLeaveDeliveryId])).rowCount, 0);

    const onTimeSchedule = await json<{ items: Array<{ id: string; pendingStopItems: Array<{ scheduledDeliveryId: string; expectedVersion: number; plannedQuantity: string }> }> }>(
      await api(`/agent/vendors/${value.vendorId}/scheduled-deliveries?serviceDate=${value.onTimeDate}`, value.agentToken), 200);
    const pending = onTimeSchedule.items.find(({ id }) => id === value.deliveredId)?.pendingStopItems;
    assert.ok(pending);
    assert.deepEqual(pending.map(({ scheduledDeliveryId }) => scheduledDeliveryId).sort(), [value.leaveDeliveryId, value.deliveredId].sort());
    const occurredAt = new Date(Date.now() - 1000).toISOString();
    const delivered = await json<{ items: Array<{ id: string; currentStatus: string; version: number }> }>(await api(`/agent/vendors/${value.vendorId}/route-stops/${value.stopId}/outcomes`, value.agentToken, {
      method: 'POST', body: { serviceDate: value.onTimeDate, outcome: 'delivered', occurredAt, items: pending.map((item) => ({
        scheduledDeliveryId: item.scheduledDeliveryId, expectedVersion: item.expectedVersion,
        actualQuantity: item.scheduledDeliveryId === value.deliveredId ? '1.500' : item.plannedQuantity,
      })) },
    }), 201);
    assert.deepEqual(delivered.items.map(({ id, currentStatus, version }) => ({ id, currentStatus, version })).sort((a, b) => a.id.localeCompare(b.id)),
      pending.map(({ scheduledDeliveryId: id, expectedVersion }) => ({ id, currentStatus: 'delivered', version: expectedVersion + 1 })).sort((a, b) => a.id.localeCompare(b.id)));
    const snapshot = (await owner.query<{ amountMinor: string; currency: string; pricingLevel: string; sourcePriceId: string; sourcePriceType: string; resolvedAt: Date }>(`SELECT amount_minor::text AS "amountMinor",currency,pricing_level AS "pricingLevel",source_price_id AS "sourcePriceId",source_price_type AS "sourcePriceType",resolved_at AS "resolvedAt"
      FROM delivery_price_snapshots WHERE scheduled_delivery_id=$1`, [value.deliveredId])).rows[0];
    assert.equal(snapshot?.amountMinor, '95'); assert.equal(snapshot?.currency, 'INR'); assert.equal(snapshot?.pricingLevel, 'customer_specific');
    assert.equal(snapshot?.sourcePriceId, value.overrideId); assert.equal(snapshot?.sourcePriceType, 'customer_price_override');
    assert.equal(snapshot?.resolvedAt.toISOString(), DateTime.fromISO(`${value.onTimeDate}T06:00`, { zone: 'Asia/Kolkata' }).toUTC().toISO());
    const original = (await owner.query<{ id: string; occurredAt: Date; receivedAt: Date; actualQuantity: string }>('SELECT id,occurred_at AS "occurredAt",received_at AS "receivedAt",actual_quantity::text AS "actualQuantity" FROM delivery_events WHERE scheduled_delivery_id=$1', [value.deliveredId])).rows[0];
    assert.ok(original); assert.equal(original.occurredAt.toISOString(), occurredAt); assert.equal(original.actualQuantity, '1.500'); assert(original.receivedAt > original.occurredAt);

    const corrected = await json<{ currentStatus: string; version: number; snapshot: { amountMinor: string }; events: Array<{ source: string; replacedEventId?: string }> }>(await api(`/vendors/${value.vendorId}/deliveries/${value.deliveredId}/corrections`, value.ownerToken, {
      method: 'POST', body: { expectedVersion: 2, replacementOutcome: 'skipped_by_agent', reason: 'Verified against route sheet' },
    }), 200);
    assert.equal(corrected.currentStatus, 'skipped_by_agent'); assert.equal(corrected.version, 3); assert.equal(corrected.snapshot.amountMinor, '95');
    const correction = corrected.events.find(({ source }) => source === 'vendor_admin'); assert.equal(correction?.replacedEventId, original?.id);
    assert.equal((await owner.query('SELECT 1 FROM delivery_price_snapshots WHERE scheduled_delivery_id=$1', [value.deliveredId])).rowCount, 1);
    const audit = (await owner.query<{ reason: string; oldValue: unknown; newValue: unknown }>("SELECT reason,old_value AS \"oldValue\",new_value AS \"newValue\" FROM audit_events WHERE vendor_id=$1 AND action='delivery.corrected'", [value.vendorId])).rows[0];
    assert.equal(audit?.reason, 'Verified against route sheet'); assert.ok(audit?.oldValue); assert.ok(audit?.newValue);

    const customerDetail = await json<{ currentStatus: string; snapshot: { amountMinor: string }; events: Array<Record<string, unknown>> }>(await api(`${customerBase}/deliveries/${value.deliveredId}`, value.customerToken), 200);
    assert.equal(customerDetail.currentStatus, 'skipped_by_agent'); assert.equal(customerDetail.snapshot.amountMinor, '95'); assert.equal(customerDetail.events.length, 2);
    assert(customerDetail.events.every((event) => !('latitude' in event) && !('longitude' in event)));
    assert.equal(customerDetail.events.find(({ source }) => source === 'vendor_admin')?.reasonCode, undefined);

    await json(await api(`/agent/vendors/${value.vendorId}/route-stops/${value.stopId}/outcomes`, value.agentToken, {
      method: 'POST', body: { serviceDate: value.skipDate, outcome: 'skipped_by_agent', occurredAt: new Date().toISOString(), reasonCode: 'customer_unavailable', items: [{ scheduledDeliveryId: value.skippedId, expectedVersion: 1 }] },
    }), 201);
    assert.equal((await owner.query('SELECT 1 FROM delivery_price_snapshots WHERE scheduled_delivery_id=$1', [value.skippedId])).rowCount, 0);
    const householdBNotificationId = randomUUID();
    await owner.query(`INSERT INTO notifications(id,vendor_id,recipient_user_id,type,payload)
      VALUES($1,$2,$3,'leave_rejected',$4::jsonb)`, [householdBNotificationId, value.vendorId, value.customerId,
      JSON.stringify({ householdId: value.foreignHouseholdId, leaveRequestId: leave.id })]);
    const notifications = await json<{ items: Array<{ id: string; type: string; payload: Record<string, string> }> }>(await api(`${customerBase}/notifications`, value.customerToken), 200);
    assert(notifications.items.some(({ type }) => type === 'delivery_corrected')); assert(notifications.items.some(({ type }) => type === 'agent_reported_skip'));
    assert.equal(notifications.items.some(({ id }) => id === householdBNotificationId), false);
    assert.equal(notifications.items.every(({ payload }) => payload.householdId === value.householdId), true);

    const denied = [
      api(`${customerBase}/deliveries/${value.deliveredId}`, value.foreignCustomerToken),
      api(`/vendors/${value.vendorId}/deliveries/${value.deliveredId}`, value.foreignOwnerToken),
      api(`/agent/vendors/${value.vendorId}/scheduled-deliveries?serviceDate=${value.onTimeDate}`, value.foreignAgentToken),
      api(`/vendors/${value.vendorId}/deliveries`, value.platformToken),
      api(`${customerBase}/notifications`, value.platformToken),
    ];
    for (const response of await Promise.all(denied)) assert.equal(response.status, 403, await response.text());
    assert.equal((await owner.query<{ count: number }>('SELECT count(*)::int count FROM delivery_events WHERE vendor_id=$1 AND scheduled_delivery_id=$2', [value.vendorId, value.deliveredId])).rows[0]?.count, 2);
    assert.equal((await owner.query<{ count: number }>('SELECT count(*)::int count FROM delivery_price_snapshots WHERE vendor_id=$1', [value.vendorId])).rows[0]?.count, 2);
    assert.equal((await owner.query<{ count: number }>("SELECT count(*)::int count FROM notifications WHERE vendor_id=$1 AND type='delivery_corrected'", [value.vendorId])).rows[0]?.count, 1);
  } finally {
    await cleanup(value);
  }
});

void test('mixed-cutoff leave approval blocks the accepted occurrence from route action', async () => {
  const value = await fixture();
  const customerBase = `/customer/vendors/${value.vendorId}/households/${value.householdId}`;
  try {
    const selection = { startDate: value.lateDate, endDate: value.onTimeDate, subscriptionIds: [value.leaveSubscriptionId], limit: 1 };
    const preview = await json<{ onTimeCount: number; lateCount: number; items: unknown[]; nextCursor?: string }>(
      await api(`${customerBase}/leave-requests/preview`, value.customerToken, { method: 'POST', body: selection }), 200);
    assert(preview.onTimeCount > 0); assert(preview.lateCount > 0); assert.equal(preview.items.length, 1); assert.ok(preview.nextCursor);

    const leave = await json<{ currentStatus: string; currentRevisionId: string }>(await api(`${customerBase}/leave-requests`, value.customerToken, {
      method: 'POST', body: { startDate: value.lateDate, endDate: value.onTimeDate, subscriptionIds: [value.leaveSubscriptionId] },
    }), 201);
    assert.equal(leave.currentStatus, 'partially_pending');
    const lateDecision = (await owner.query<{ id: string; version: number }>(`SELECT id,version FROM leave_occurrence_decisions
      WHERE vendor_id=$1 AND leave_request_revision_id=$2 AND service_date=$3 AND status='pending'`,
    [value.vendorId, leave.currentRevisionId, value.lateDate])).rows[0];
    assert.ok(lateDecision);
    const approved = await json<{ currentStatus: string }>(await api(`/vendors/${value.vendorId}/leave-occurrence-decisions/${lateDecision.id}/decision`, value.ownerToken, {
      method: 'POST', body: { expectedVersion: lateDecision.version, decision: 'approved', reason: 'Route can absorb leave' },
    }), 200);
    assert.equal(approved.currentStatus, 'approved');
    assert.deepEqual((await owner.query('SELECT status FROM scheduled_deliveries WHERE id=$1', [value.lateDeliveryId])).rows, [{ status: 'skipped_by_customer' }]);

    const schedule = await json<{ items: Array<{ id: string; blockedByCustomerLeave: boolean; pendingStopItems: Array<{ scheduledDeliveryId: string }> }> }>(
      await api(`/agent/vendors/${value.vendorId}/scheduled-deliveries?serviceDate=${value.lateDate}`, value.agentToken), 200);
    const blocked = schedule.items.find(({ id }) => id === value.lateDeliveryId);
    assert.equal(blocked?.blockedByCustomerLeave, true);
    assert(!blocked?.pendingStopItems.some(({ scheduledDeliveryId }) => scheduledDeliveryId === value.lateDeliveryId));
    const before = await owner.query<{ events: number; snapshots: number }>(`SELECT
      (SELECT count(*)::int FROM delivery_events WHERE vendor_id=$1 AND scheduled_delivery_id=$2) AS events,
      (SELECT count(*)::int FROM delivery_price_snapshots WHERE vendor_id=$1 AND scheduled_delivery_id=$2) AS snapshots`,
    [value.vendorId, value.lateDeliveryId]);
    const blockedAttempt = await api(`/agent/vendors/${value.vendorId}/route-stops/${value.stopId}/outcomes`, value.agentToken, {
      method: 'POST', body: { serviceDate: value.lateDate, outcome: 'delivered', occurredAt: new Date().toISOString(),
        items: [{ scheduledDeliveryId: value.lateDeliveryId, expectedVersion: 2, actualQuantity: '1' }] },
    });
    assert.equal(blockedAttempt.status, 409);
    assert.deepEqual((await owner.query<{ events: number; snapshots: number }>(`SELECT
      (SELECT count(*)::int FROM delivery_events WHERE vendor_id=$1 AND scheduled_delivery_id=$2) AS events,
      (SELECT count(*)::int FROM delivery_price_snapshots WHERE vendor_id=$1 AND scheduled_delivery_id=$2) AS snapshots`,
    [value.vendorId, value.lateDeliveryId])).rows, before.rows);
  } finally {
    await cleanup(value);
  }
});
