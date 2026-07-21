import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";

const ownerPool = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});
const authKey = Buffer.from(process.env.AUTH_HMAC_KEY!, "base64");
const users: string[] = [];
const vendors: string[] = [];
let app: INestApplication;
let baseUrl = "";
type HouseholdResponse = Readonly<{
  id: string;
  version: number;
  accountNumber: string;
  status: "active" | "inactive";
  lifecycle: "current" | "deleted";
}>;
const hash = (token: string) =>
  createHmac("sha256", authKey).update(token).digest("hex");
async function user(name: string) {
  const id = randomUUID();
  users.push(id);
  await ownerPool.query(
    `INSERT INTO users (id,display_name,updated_at) VALUES ($1,$2,now())`,
    [id, name],
  );
  return id;
}
async function vendor(status = "active") {
  const id = randomUUID();
  vendors.push(id);
  await ownerPool.query(
    `INSERT INTO vendors (id,code,legal_name,display_name,status,timezone,currency,skip_cutoff_minutes,billing_day,updated_at) VALUES ($1,$2,'Household Vendor','Household Vendor',$3::"VendorStatus",'Asia/Kolkata','INR',0,1,now())`,
    [id, `household-${id}`, status],
  );
  return id;
}
async function membership(
  vendorId: string,
  userId: string,
  role: "vendor_owner" | "vendor_administrator" | "customer" | "delivery_agent",
  status = "active",
) {
  const id = randomUUID();
  await ownerPool.query(
    `INSERT INTO vendor_memberships (id,vendor_id,user_id,role,status,joined_at,ended_at,updated_at) VALUES ($1,$2,$3,$4::"MembershipRole",$5::"MembershipStatus",now(),CASE WHEN $5='ended' THEN now() END,now())`,
    [id, vendorId, userId, role, status],
  );
  return id;
}
async function session(
  userId: string,
  method: "administrator_mfa" | "phone_otp",
) {
  const token = randomUUID();
  if (method === "administrator_mfa")
    await ownerPool.query(
      `INSERT INTO mfa_factors (id,user_id,type,encrypted_secret,enabled_at) VALUES ($1,$2,'totp','household',now())`,
      [randomUUID(), userId],
    );
  await ownerPool.query(
    `INSERT INTO sessions (id,user_id,access_token_hash,refresh_token_hash,authentication_method,device_id,access_expires_at,expires_at,last_seen_at) VALUES ($1,$2,$3,$4,$5::"AuthenticationMethod",'household',now()+interval '1 hour',now()+interval '1 day',now())`,
    [randomUUID(), userId, hash(token), hash(randomUUID()), method],
  );
  return token;
}
async function phone(userId: string) {
  await ownerPool.query(
    `INSERT INTO user_identities (id,user_id,type,normalized_value,verified_at,is_primary,updated_at) VALUES ($1,$2,'phone',$3,now(),true,now())`,
    [
      randomUUID(),
      userId,
      `+91${randomUUID().replaceAll("-", "").slice(0, 10)}`,
    ],
  );
}
function api(
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
async function expectError(response: Response, status: number, code?: string) {
  assert.equal(response.status, status);
  const body = (await response.json()) as { code?: string };
  if (code) assert.equal(body.code, code);
}

before(async () => {
  const { createApp } = await import("../src/bootstrap/create-app.js");
  app = await createApp({ logger: false });
  await app.listen(0, "127.0.0.1");
  const address = (app.getHttpServer() as Server).address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await app?.close();
  await ownerPool.query(
    "DELETE FROM audit_events WHERE vendor_id=ANY($1::uuid[])",
    [vendors],
  );
  await ownerPool.query(
    "DELETE FROM household_members WHERE vendor_id=ANY($1::uuid[])",
    [vendors],
  );
  await ownerPool.query(
    "DELETE FROM support_access_grants WHERE vendor_id=ANY($1::uuid[])",
    [vendors],
  );
  await ownerPool.query(
    "DELETE FROM households WHERE vendor_id=ANY($1::uuid[])",
    [vendors],
  );
  await ownerPool.query(
    "DELETE FROM vendor_memberships WHERE vendor_id=ANY($1::uuid[])",
    [vendors],
  );
  await ownerPool.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [
    users,
  ]);
  await ownerPool.query(
    "DELETE FROM mfa_factors WHERE user_id=ANY($1::uuid[])",
    [users],
  );
  await ownerPool.query(
    "DELETE FROM user_identities WHERE user_id=ANY($1::uuid[])",
    [users],
  );
  await ownerPool.query(
    "DELETE FROM platform_role_assignments WHERE user_id=ANY($1::uuid[])",
    [users],
  );
  await ownerPool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
  await ownerPool.query("DELETE FROM vendors WHERE id=ANY($1::uuid[])", [
    vendors,
  ]);
  await ownerPool.end();
});

void test("administrator household lifecycle, customer visibility, authorization, validation, audit, and concurrency contract", async () => {
  const vendorId = await vendor(),
    otherVendor = await vendor();
  const owner = await user("Owner"),
    customer = await user("Customer"),
    other = await user("Other"),
    agent = await user("Agent");
  const ownerMembership = await membership(vendorId, owner, "vendor_owner"),
    customerMembership = await membership(vendorId, customer, "customer"),
    otherMembership = await membership(otherVendor, other, "customer");
  await membership(vendorId, agent, "delivery_agent");
  await phone(customer);
  await phone(other);
  const ownerToken = await session(owner, "administrator_mfa"),
    customerToken = await session(customer, "phone_otp"),
    agentToken = await session(agent, "phone_otp");
  const body = {
    accountNumber: "HH-0001",
    name: "Shah Household",
    addressLine1: "12 Market Road",
    city: "Ahmedabad",
    region: "Gujarat",
    postalCode: "380001",
    countryCode: "IN",
    latitude: "23.022500",
    longitude: "72.571400",
  };
  const createdResponse = await api(
    `/v1/vendors/${vendorId}/households`,
    ownerToken,
    { method: "POST", body },
  );
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()) as HouseholdResponse;
  assert.equal(created.version, 1);
  assert.equal(created.accountNumber, "HH-0001");
  assert.deepEqual(Object.keys(created).sort(), [
    "accountNumber",
    "addressLine1",
    "city",
    "countryCode",
    "createdAt",
    "id",
    "latitude",
    "lifecycle",
    "longitude",
    "name",
    "postalCode",
    "region",
    "status",
    "updatedAt",
    "vendorId",
    "version",
  ]);
  const missingLongitude = {
    accountNumber: body.accountNumber,
    name: body.name,
    addressLine1: body.addressLine1,
    city: body.city,
    region: body.region,
    postalCode: body.postalCode,
    countryCode: body.countryCode,
    latitude: body.latitude,
  };
  await expectError(
    await api(`/v1/vendors/${vendorId}/households`, ownerToken, {
      method: "POST",
      body: { ...body, unknown: true },
    }),
    400,
  );
  await expectError(
    await api(`/v1/vendors/${vendorId}/households`, ownerToken, {
      method: "POST",
      body: { ...missingLongitude, accountNumber: "HH-0002" },
    }),
    400,
    "INVALID_COORDINATES",
  );
  await expectError(
    await api(`/v1/vendors/${vendorId}/households`, agentToken),
    403,
    "FORBIDDEN",
  );
  const attached = await api(
    `/v1/vendors/${vendorId}/households/${created.id}/members`,
    ownerToken,
    { method: "POST", body: { customerMembershipId: customerMembership } },
  );
  assert.equal(attached.status, 201);
  await expectError(
    await api(
      `/v1/vendors/${vendorId}/households/${created.id}/members`,
      ownerToken,
      { method: "POST", body: { customerMembershipId: otherMembership } },
    ),
    404,
    "CUSTOMER_MEMBERSHIP_NOT_FOUND",
  );
  await expectError(
    await api(
      `/v1/vendors/${vendorId}/households/${created.id}/members`,
      ownerToken,
      { method: "POST", body: { customerMembershipId: customerMembership } },
    ),
    409,
  );
  const customerList = await api(
    `/v1/customer/vendors/${vendorId}/households`,
    customerToken,
  );
  assert.equal(customerList.status, 200);
  assert.equal(
    ((await customerList.json()) as { items: unknown[] }).items.length,
    1,
  );
  const updated = await api(
    `/v1/vendors/${vendorId}/households/${created.id}`,
    ownerToken,
    {
      method: "PATCH",
      body: { expectedVersion: 1, name: "Updated Household" },
    },
  );
  assert.equal(updated.status, 200);
  await expectError(
    await api(`/v1/vendors/${vendorId}/households/${created.id}`, ownerToken, {
      method: "PATCH",
      body: { expectedVersion: 1, name: "Stale" },
    }),
    409,
    "HOUSEHOLD_VERSION_CONFLICT",
  );
  await expectError(
    await api(`/v1/vendors/${vendorId}/households/${created.id}`, ownerToken, {
      method: "DELETE",
      body: { expectedVersion: 1, reason: "Remove household" },
    }),
    409,
    "HOUSEHOLD_VERSION_CONFLICT",
  );
  const deleted = await api(
    `/v1/vendors/${vendorId}/households/${created.id}`,
    ownerToken,
    {
      method: "DELETE",
      body: { expectedVersion: 2, reason: "Remove household" },
    },
  );
  assert.equal(deleted.status, 204);
  assert.equal(
    (await api(`/v1/customer/vendors/${vendorId}/households`, customerToken))
      .status,
    200,
  );
  await expectError(
    await api(
      `/v1/vendors/${vendorId}/households/${created.id}/restore`,
      ownerToken,
      {
        method: "POST",
        body: { expectedVersion: 2, reason: "Restore household" },
      },
    ),
    409,
    "HOUSEHOLD_VERSION_CONFLICT",
  );
  assert.equal(
    (
      await api(
        `/v1/vendors/${vendorId}/households/${created.id}/restore`,
        ownerToken,
        {
          method: "POST",
          body: { expectedVersion: 3, reason: "Restore household" },
        },
      )
    ).status,
    200,
  );
  const audits = await ownerPool.query<{ action: string; new_value: unknown }>(
    `SELECT action,new_value FROM audit_events WHERE vendor_id=$1 AND entity_type='household'`,
    [vendorId],
  );
  assert.ok(audits.rows.some((row) => row.action === "household.created"));
  assert.equal(JSON.stringify(audits.rows).includes("HH-0001"), false);
  assert.equal(ownerMembership.length, 36);
});

void test("replacement memberships cannot revive ended or role-changed household links", async () => {
  const vendorId = await vendor();
  const owner = await user("Owner");
  const endedCustomer = await user("Ended customer");
  const roleChangedCustomer = await user("Role changed customer");
  await membership(vendorId, owner, "vendor_owner");
  const endedMembership = await membership(vendorId, endedCustomer, "customer");
  const roleChangedMembership = await membership(
    vendorId,
    roleChangedCustomer,
    "customer",
  );
  await phone(endedCustomer);
  await phone(roleChangedCustomer);
  const ownerToken = await session(owner, "administrator_mfa");
  const endedToken = await session(endedCustomer, "phone_otp");
  const roleChangedToken = await session(roleChangedCustomer, "phone_otp");
  const body = {
    name: "Household",
    addressLine1: "12 Market Road",
    city: "Ahmedabad",
    region: "Gujarat",
    postalCode: "380001",
    countryCode: "IN",
  };
  const created = await api(`/v1/vendors/${vendorId}/households`, ownerToken, {
    method: "POST",
    body: { ...body, accountNumber: "HH-ENDED" },
  });
  assert.equal(created.status, 201);
  const household = (await created.json()) as HouseholdResponse;
  assert.equal(
    (
      await api(
        `/v1/vendors/${vendorId}/households/${household.id}/members`,
        ownerToken,
        { method: "POST", body: { customerMembershipId: endedMembership } },
      )
    ).status,
    201,
  );
  await ownerPool.query(
    `UPDATE vendor_memberships SET status='ended',ended_at=now() WHERE id=$1`,
    [endedMembership],
  );
  await membership(vendorId, endedCustomer, "customer");
  assert.deepEqual(
    (
      (await (
        await api(`/v1/customer/vendors/${vendorId}/households`, endedToken)
      ).json()) as { items: unknown[] }
    ).items,
    [],
  );
  assert.equal(
    (
      await api(
        `/v1/vendors/${vendorId}/households/${household.id}/members`,
        ownerToken,
        {
          method: "POST",
          body: { customerMembershipId: roleChangedMembership },
        },
      )
    ).status,
    201,
  );
  await ownerPool.query(
    `UPDATE vendor_memberships SET role='delivery_agent' WHERE id=$1`,
    [roleChangedMembership],
  );
  await membership(vendorId, roleChangedCustomer, "customer");
  assert.deepEqual(
    (
      (await (
        await api(
          `/v1/customer/vendors/${vendorId}/households`,
          roleChangedToken,
        )
      ).json()) as { items: unknown[] }
    ).items,
    [],
  );
});

void test("attach serializes concurrent membership revocation before inserting the household link", async () => {
  const vendorId = await vendor();
  const owner = await user("Owner");
  await membership(vendorId, owner, "vendor_owner");
  const ownerToken = await session(owner, "administrator_mfa");
  const body = {
    name: "Household",
    addressLine1: "12 Market Road",
    city: "Ahmedabad",
    region: "Gujarat",
    postalCode: "380001",
    countryCode: "IN",
  };
  for (const operation of ["end", "delete", "role"] as const) {
    const customer = await user(`Customer ${operation}`);
    const customerMembershipId = await membership(
      vendorId,
      customer,
      "customer",
    );
    await phone(customer);
    const created = await api(
      `/v1/vendors/${vendorId}/households`,
      ownerToken,
      { method: "POST", body: { ...body, accountNumber: `HH-${operation}` } },
    );
    assert.equal(created.status, 201);
    const household = (await created.json()) as HouseholdResponse;
    const blocker = await ownerPool.connect();
    let open = false;
    try {
      await blocker.query("BEGIN");
      open = true;
      await blocker.query(
        operation === "end"
          ? `UPDATE vendor_memberships SET status='ended',ended_at=now() WHERE id=$1`
          : operation === "delete"
            ? `UPDATE vendor_memberships SET deleted_at=now(),deleted_by=$1,deletion_reason='Concurrent removal' WHERE id=$2`
            : `UPDATE vendor_memberships SET role='delivery_agent' WHERE id=$1`,
        operation === "delete"
          ? [owner, customerMembershipId]
          : [customerMembershipId],
      );
      const attach = api(
        `/v1/vendors/${vendorId}/households/${household.id}/members`,
        ownerToken,
        { method: "POST", body: { customerMembershipId } },
      );
      assert.equal(
        await Promise.race([
          attach.then(() => false),
          new Promise<true>((resolve) => setTimeout(() => resolve(true), 100)),
        ]),
        true,
      );
      await blocker.query("COMMIT");
      open = false;
      assert.equal((await attach).status, 404);
      const link = await ownerPool.query<{ count: string }>(
        `SELECT count(*) FROM household_members WHERE household_id=$1 AND customer_membership_id=$2`,
        [household.id, customerMembershipId],
      );
      assert.equal(link.rows[0]?.count, "0");
    } finally {
      if (open) await blocker.query("ROLLBACK");
      blocker.release();
    }
  }
});

void test("inactive lifecycle projections, conflicts, audit shapes, and customer response privacy are stable", async () => {
  const vendorId = await vendor();
  const owner = await user("Owner");
  const customer = await user("Customer");
  await membership(vendorId, owner, "vendor_owner");
  const customerMembershipId = await membership(vendorId, customer, "customer");
  await phone(customer);
  const ownerToken = await session(owner, "administrator_mfa");
  const customerToken = await session(customer, "phone_otp");
  const body = {
    name: "Private household",
    addressLine1: "12 Market Road",
    city: "Ahmedabad",
    region: "Gujarat",
    postalCode: "380001",
    countryCode: "IN",
    notes: "Private delivery instruction",
  };
  const first = await api(`/v1/vendors/${vendorId}/households`, ownerToken, {
    method: "POST",
    body: { ...body, accountNumber: "HH-AUDIT" },
  });
  assert.equal(first.status, 201);
  const household = (await first.json()) as HouseholdResponse;
  const second = await api(`/v1/vendors/${vendorId}/households`, ownerToken, {
    method: "POST",
    body: { ...body, accountNumber: "HH-CONFLICT" },
  });
  assert.equal(second.status, 201);
  const duplicate = (await second.json()) as HouseholdResponse;
  const attached = await api(
    `/v1/vendors/${vendorId}/households/${household.id}/members`,
    ownerToken,
    { method: "POST", body: { customerMembershipId } },
  );
  assert.equal(attached.status, 201);
  const member = (await attached.json()) as { id: string };
  const customerPage = await api(
    `/v1/customer/vendors/${vendorId}/households`,
    customerToken,
  );
  assert.equal(customerPage.status, 200);
  const customerHousehold = (
    (await customerPage.json()) as { items: Record<string, unknown>[] }
  ).items[0];
  assert.ok(customerHousehold);
  assert.equal("notes" in customerHousehold, false);
  const updated = await api(
    `/v1/vendors/${vendorId}/households/${household.id}`,
    ownerToken,
    { method: "PATCH", body: { expectedVersion: 1, status: "inactive" } },
  );
  assert.equal(updated.status, 200);
  assert.equal(
    ((await updated.json()) as { status: string }).status,
    "inactive",
  );
  await expectError(
    await api(
      `/v1/vendors/${vendorId}/households/${duplicate.id}`,
      ownerToken,
      {
        method: "PATCH",
        body: { expectedVersion: 1, accountNumber: "HH-AUDIT" },
      },
    ),
    409,
    "HOUSEHOLD_CONFLICT",
  );
  assert.equal(
    (
      await api(
        `/v1/vendors/${vendorId}/households/${household.id}/members/${member.id}/end`,
        ownerToken,
        { method: "POST", body: { reason: "End membership" } },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await api(
        `/v1/vendors/${vendorId}/households/${household.id}`,
        ownerToken,
        {
          method: "DELETE",
          body: { expectedVersion: 2, reason: "Delete household" },
        },
      )
    ).status,
    204,
  );
  const restored = await api(
    `/v1/vendors/${vendorId}/households/${household.id}/restore`,
    ownerToken,
    {
      method: "POST",
      body: { expectedVersion: 3, reason: "Restore household" },
    },
  );
  assert.equal(restored.status, 200);
  assert.equal(
    ((await restored.json()) as { status: string }).status,
    "inactive",
  );
  const audits = await ownerPool.query<{
    action: string;
    entity_type: string;
    entity_id: string;
    new_value: Record<string, unknown> | null;
    reason: string | null;
  }>(
    `SELECT action,entity_type,entity_id,new_value,reason FROM audit_events WHERE vendor_id=$1 ORDER BY created_at,id`,
    [vendorId],
  );
  const expected = [
    [
      "household.created",
      "household",
      household.id,
      ["status", "version"],
      null,
    ],
    [
      "household.member_attached",
      "household_member",
      member.id,
      ["status"],
      null,
    ],
    [
      "household.updated",
      "household",
      household.id,
      ["changedFields", "status", "version"],
      null,
    ],
    [
      "household.member_ended",
      "household_member",
      member.id,
      ["status"],
      "End membership",
    ],
    [
      "household.deleted",
      "household",
      household.id,
      ["status", "version"],
      "Delete household",
    ],
    [
      "household.restored",
      "household",
      household.id,
      ["status", "version"],
      "Restore household",
    ],
  ];
  for (const [action, entityType, entityId, keys, reason] of expected) {
    const audit = audits.rows.find(
      (row) => row.action === action && row.entity_id === entityId,
    );
    assert.ok(audit);
    assert.equal(audit.entity_type, entityType);
    assert.deepEqual(Object.keys(audit.new_value ?? {}).sort(), keys);
    assert.equal(audit.reason, reason);
    assert.equal(
      JSON.stringify(audit.new_value).match(
        /HH-AUDIT|Private household|Private delivery instruction|\+91/,
      ),
      null,
    );
  }
});

void test("vendor list defaults active while current detail includes inactive households", async () => {
  const vendorId = await vendor();
  const owner = await user("List owner");
  await membership(vendorId, owner, "vendor_owner");
  const token = await session(owner, "administrator_mfa");
  const body = {
    name: "Household",
    addressLine1: "Road",
    city: "City",
    region: "Region",
    postalCode: "12345",
    countryCode: "IN",
  };
  const activeResponse = await api(
    `/v1/vendors/${vendorId}/households`,
    token,
    { method: "POST", body: { ...body, accountNumber: "ACTIVE" } },
  );
  const inactiveResponse = await api(
    `/v1/vendors/${vendorId}/households`,
    token,
    { method: "POST", body: { ...body, accountNumber: "INACTIVE" } },
  );
  const deletedResponse = await api(
    `/v1/vendors/${vendorId}/households`,
    token,
    { method: "POST", body: { ...body, accountNumber: "DELETED" } },
  );
  const active = (await activeResponse.json()) as HouseholdResponse;
  const inactive = (await inactiveResponse.json()) as HouseholdResponse;
  const deleted = (await deletedResponse.json()) as HouseholdResponse;
  assert.equal(
    (
      await api(`/v1/vendors/${vendorId}/households/${inactive.id}`, token, {
        method: "PATCH",
        body: { expectedVersion: 1, status: "inactive" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api(`/v1/vendors/${vendorId}/households/${deleted.id}`, token, {
        method: "DELETE",
        body: { expectedVersion: 1, reason: "Delete household" },
      })
    ).status,
    204,
  );
  const page = (await (
    await api(`/v1/vendors/${vendorId}/households`, token)
  ).json()) as { items: { id: string }[] };
  assert.deepEqual(
    page.items.map(({ id }) => id),
    [active.id],
  );
  assert.equal(
    (await api(`/v1/vendors/${vendorId}/households/${active.id}`, token))
      .status,
    200,
  );
  assert.equal(
    (await api(`/v1/vendors/${vendorId}/households/${inactive.id}`, token))
      .status,
    200,
  );
  await expectError(
    await api(`/v1/vendors/${vendorId}/households/${deleted.id}`, token),
    404,
    "HOUSEHOLD_NOT_FOUND",
  );
});

void test("vendor household discovery composes validated search, status, tenant, soft-delete, and cursor filters", async () => {
  const vendorId = await vendor();
  const otherVendorId = await vendor();
  const owner = await user("Discovery owner");
  await membership(vendorId, owner, "vendor_owner");
  const token = await session(owner, "administrator_mfa");
  const createdAt = new Date("2026-07-20T01:00:00.000Z");
  const activeIds = Array.from({ length: 5 }, () => randomUUID());
  const inactiveIds = Array.from({ length: 3 }, () => randomUUID()).sort().reverse();
  const nonSearchableId = randomUUID();
  const literalWildcardId = randomUUID();
  const deletedId = randomUUID();
  const otherVendorHouseholdId = randomUUID();

  await ownerPool.query(
    `INSERT INTO households
       (id,vendor_id,account_number,name,address_line_1,address_line_2,locality,city,region,postal_code,country_code,status,notes,created_at,updated_at,deleted_at)
     VALUES
       ($1,$6,'Find-Account','Ordinary','Road',NULL,NULL,'City','Region','10001','IN','active',NULL,$7,$7,NULL),
       ($2,$6,'ACCOUNT-2','Find-Name','Road',NULL,NULL,'City','Region','10002','IN','active',NULL,$7,$7,NULL),
       ($3,$6,'ACCOUNT-3','Ordinary','Find-Address',NULL,NULL,'City','Region','10003','IN','active',NULL,$7,$7,NULL),
       ($4,$6,'ACCOUNT-4','Ordinary','Road',NULL,NULL,'Find-City','Region','10004','IN','active',NULL,$7,$7,NULL),
       ($5,$6,'ACCOUNT-5','Ordinary','Road',NULL,NULL,'City','Region','Find-Postal','IN','active',NULL,$7,$7,NULL)`,
    [...activeIds, vendorId, createdAt],
  );
  await ownerPool.query(
    `INSERT INTO households
       (id,vendor_id,account_number,name,address_line_1,address_line_2,locality,city,region,postal_code,country_code,status,notes,created_at,updated_at)
     VALUES ($1,$2,'ACCOUNT-6','Ordinary','Road','Hidden-Marker','Hidden-Marker','City','Hidden-Marker','10006','IN','active','Hidden-Marker',$3,$3)`,
    [nonSearchableId, vendorId, createdAt],
  );
  await ownerPool.query(
    `INSERT INTO households
       (id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,status,created_at,updated_at)
     VALUES ($1,$2,'LITERAL-%_\\-SEARCH','Literal wildcard','Road','City','Region','10007','IN','active',$3,$3)`,
    [literalWildcardId, vendorId, createdAt],
  );
  await ownerPool.query(
    `INSERT INTO households
       (id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,status,created_at,updated_at)
     SELECT id::uuid,$2,'DISCOVERY-NEEDLE-'||ordinality,'Inactive needle','Needle Road','Needle City','Region','Needle Postal','IN','inactive',$3,$3
     FROM unnest($1::text[]) WITH ORDINALITY AS seeded(id,ordinality)`,
    [inactiveIds, vendorId, createdAt],
  );
  await ownerPool.query(
    `INSERT INTO households
       (id,vendor_id,account_number,name,address_line_1,address_line_2,locality,city,region,postal_code,country_code,status,notes,created_at,updated_at,deleted_at)
     VALUES
       ($1,$3,'DELETED-NEEDLE','Deleted needle','Needle Road',NULL,NULL,'Needle City','Region','Needle Postal','IN','inactive',NULL,$5,$5,$5),
       ($2,$4,'OTHER-NEEDLE','Other needle','Needle Road',NULL,NULL,'Needle City','Region','Needle Postal','IN','inactive',NULL,$5,$5,NULL)`,
    [deletedId, otherVendorHouseholdId, vendorId, otherVendorId, createdAt],
  );

  for (const [term, expectedId] of [
    ["find-account", activeIds[0]],
    ["find-name", activeIds[1]],
    ["find-address", activeIds[2]],
    ["find-city", activeIds[3]],
    ["find-postal", activeIds[4]],
  ] as const) {
    const response = await api(
      `/v1/vendors/${vendorId}/households?search=${encodeURIComponent(`  ${term.toUpperCase()}  `)}`,
      token,
    );
    assert.equal(response.status, 200);
    const page = (await response.json()) as { items: { id: string }[] };
    assert.deepEqual(page.items.map(({ id }) => id), [expectedId]);
  }
  const restrictedSearch = (await (
    await api(
      `/v1/vendors/${vendorId}/households?search=hidden-marker`,
      token,
    )
  ).json()) as { items: { id: string }[] };
  assert.deepEqual(restrictedSearch.items, []);

  for (const term of ['%', '_', '\\']) {
    const response = await api(
      `/v1/vendors/${vendorId}/households?search=${encodeURIComponent(term)}`,
      token,
    );
    assert.equal(response.status, 200);
    const page = (await response.json()) as { items: { id: string }[] };
    assert.deepEqual(page.items.map(({ id }) => id), [literalWildcardId]);
  }

  const defaultPage = (await (
    await api(`/v1/vendors/${vendorId}/households`, token)
  ).json()) as { items: { id: string; status: string }[] };
  assert.equal(defaultPage.items.length, activeIds.length + 2);
  assert.ok(defaultPage.items.every(({ status }) => status === "active"));

  const firstResponse = await api(
    `/v1/vendors/${vendorId}/households?search=NeEdLe&status=inactive&limit=2`,
    token,
  );
  assert.equal(firstResponse.status, 200);
  const firstPage = (await firstResponse.json()) as {
    items: { id: string }[];
    nextCursor?: string;
  };
  assert.deepEqual(firstPage.items.map(({ id }) => id), inactiveIds.slice(0, 2));
  assert.ok(firstPage.nextCursor);
  const secondResponse = await api(
    `/v1/vendors/${vendorId}/households?search=needle&status=inactive&limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    token,
  );
  assert.equal(secondResponse.status, 200);
  const secondPage = (await secondResponse.json()) as {
    items: { id: string }[];
    nextCursor?: string;
  };
  assert.deepEqual(secondPage.items.map(({ id }) => id), inactiveIds.slice(2));
  assert.equal(secondPage.nextCursor, undefined);

  for (const query of [
    "search=",
    "search=%20%20",
    `search=${"x".repeat(161)}`,
    "status=archived",
    "unknown=true",
  ]) {
    await expectError(
      await api(`/v1/vendors/${vendorId}/households?${query}`, token),
      400,
      "INVALID_REQUEST",
    );
  }
});

void test("household cursor pagination is bounded and stable across equal timestamps", async () => {
  const vendorId = await vendor();
  const owner = await user("Pagination owner");
  await membership(vendorId, owner, "vendor_owner");
  const token = await session(owner, "administrator_mfa");
  const ids = Array.from({ length: 101 }, () => randomUUID());
  await ownerPool.query(
    `INSERT INTO households (id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,created_at,updated_at)
     SELECT id::uuid,$2,'PAGE-'||ordinality,'Household','Road','City','Region','12345','IN',$3,$3
     FROM unnest($1::text[]) WITH ORDINALITY AS seeded(id,ordinality)`,
    [ids, vendorId, new Date("2026-07-20T00:00:00.000Z")],
  );
  const defaultPage = (await (
    await api(`/v1/vendors/${vendorId}/households`, token)
  ).json()) as { items: unknown[]; nextCursor?: string };
  assert.equal(defaultPage.items.length, 25);
  assert.ok(defaultPage.nextCursor);
  const maximumPage = (await (
    await api(`/v1/vendors/${vendorId}/households?limit=100`, token)
  ).json()) as { items: unknown[]; nextCursor?: string };
  assert.equal(maximumPage.items.length, 100);
  assert.ok(maximumPage.nextCursor);
  const traversed: string[] = [];
  let cursor: string | undefined;
  do {
    const page = (await (
      await api(
        `/v1/vendors/${vendorId}/households?limit=40${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        token,
      )
    ).json()) as { items: { id: string }[]; nextCursor?: string };
    traversed.push(...page.items.map(({ id }) => id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(traversed, [...ids].sort().reverse());
  assert.equal(new Set(traversed).size, 101);
  await expectError(
    await api(`/v1/vendors/${vendorId}/households?limit=101`, token),
    400,
    "INVALID_REQUEST",
  );
  await expectError(
    await api(`/v1/vendors/${vendorId}/households?cursor=invalid`, token),
    400,
    "INVALID_CURSOR",
  );
});

void test("customer list excludes ended links, inactive or deleted households, other users, and other vendors", async () => {
  const vendorId = await vendor();
  const otherVendorId = await vendor();
  const owner = await user("Owner");
  const customer = await user("Customer");
  const otherCustomer = await user("Other customer");
  await membership(vendorId, owner, "vendor_owner");
  const customerMembership = await membership(vendorId, customer, "customer");
  const otherMembership = await membership(vendorId, otherCustomer, "customer");
  const otherVendorMembership = await membership(
    otherVendorId,
    customer,
    "customer",
  );
  await phone(customer);
  await phone(otherCustomer);
  const ownerToken = await session(owner, "administrator_mfa");
  const customerToken = await session(customer, "phone_otp");
  const body = {
    name: "Household",
    addressLine1: "Road",
    city: "City",
    region: "Region",
    postalCode: "12345",
    countryCode: "IN",
  };
  const households: HouseholdResponse[] = [];
  for (const accountNumber of [
    "VISIBLE",
    "ENDED",
    "INACTIVE",
    "DELETED",
    "OTHER",
  ]) {
    const response = await api(
      `/v1/vendors/${vendorId}/households`,
      ownerToken,
      { method: "POST", body: { ...body, accountNumber } },
    );
    households.push((await response.json()) as HouseholdResponse);
  }
  for (const [index, membershipId] of [
    [0, customerMembership],
    [1, customerMembership],
    [2, customerMembership],
    [3, customerMembership],
    [4, otherMembership],
  ] as const) {
    const response = await api(
      `/v1/vendors/${vendorId}/households/${households[index].id}/members`,
      ownerToken,
      { method: "POST", body: { customerMembershipId: membershipId } },
    );
    const link = (await response.json()) as { id: string };
    if (index === 1)
      await api(
        `/v1/vendors/${vendorId}/households/${households[index].id}/members/${link.id}/end`,
        ownerToken,
        { method: "POST", body: { reason: "End membership" } },
      );
  }
  await api(
    `/v1/vendors/${vendorId}/households/${households[2].id}`,
    ownerToken,
    { method: "PATCH", body: { expectedVersion: 1, status: "inactive" } },
  );
  await api(
    `/v1/vendors/${vendorId}/households/${households[3].id}`,
    ownerToken,
    {
      method: "DELETE",
      body: { expectedVersion: 1, reason: "Delete household" },
    },
  );
  const otherVendorHousehold = randomUUID();
  await ownerPool.query(
    `INSERT INTO households (id,vendor_id,account_number,name,address_line_1,city,region,postal_code,country_code,updated_at) VALUES ($1,$2,'OTHER-VENDOR','Other','Road','City','Region','12345','IN',now())`,
    [otherVendorHousehold, otherVendorId],
  );
  await ownerPool.query(
    `INSERT INTO household_members (id,vendor_id,household_id,customer_membership_id,joined_at,updated_at) VALUES ($1,$2,$3,$4,now(),now())`,
    [randomUUID(), otherVendorId, otherVendorHousehold, otherVendorMembership],
  );
  const page = (await (
    await api(`/v1/customer/vendors/${vendorId}/households`, customerToken)
  ).json()) as { items: { id: string }[] };
  assert.deepEqual(
    page.items.map(({ id }) => id),
    [households[0].id],
  );
});

void test("restore conflicts, normalized validation, and duplicate updates return stable errors", async () => {
  const vendorId = await vendor();
  const owner = await user("Validation owner");
  await membership(vendorId, owner, "vendor_owner");
  const token = await session(owner, "administrator_mfa");
  const body = {
    name: "Household",
    addressLine1: "Road",
    city: "City",
    region: "Region",
    postalCode: "12345",
    countryCode: "IN",
  };
  const deletedResponse = await api(
    `/v1/vendors/${vendorId}/households`,
    token,
    { method: "POST", body: { ...body, accountNumber: "REUSE" } },
  );
  const deleted = (await deletedResponse.json()) as HouseholdResponse;
  await api(`/v1/vendors/${vendorId}/households/${deleted.id}`, token, {
    method: "DELETE",
    body: { expectedVersion: 1, reason: "Delete household" },
  });
  await api(`/v1/vendors/${vendorId}/households`, token, {
    method: "POST",
    body: { ...body, accountNumber: "REUSE" },
  });
  await expectError(
    await api(
      `/v1/vendors/${vendorId}/households/${deleted.id}/restore`,
      token,
      {
        method: "POST",
        body: { expectedVersion: 2, reason: "Restore household" },
      },
    ),
    409,
    "HOUSEHOLD_CONFLICT",
  );
  const targetResponse = await api(
    `/v1/vendors/${vendorId}/households`,
    token,
    { method: "POST", body: { ...body, accountNumber: "TARGET" } },
  );
  const target = (await targetResponse.json()) as HouseholdResponse;
  await expectError(
    await api(`/v1/vendors/${vendorId}/households/${target.id}`, token, {
      method: "PATCH",
      body: { expectedVersion: 1 },
    }),
    400,
    "EMPTY_UPDATE",
  );
  await expectError(
    await api(`/v1/vendors/${vendorId}/households/${target.id}`, token, {
      method: "PATCH",
      body: { expectedVersion: 1, name: "   " },
    }),
    400,
    "INVALID_HOUSEHOLD_FIELD",
  );
  await expectError(
    await api(`/v1/vendors/${vendorId}/households/${target.id}`, token, {
      method: "PATCH",
      body: { expectedVersion: 1, accountNumber: "REUSE" },
    }),
    409,
    "HOUSEHOLD_CONFLICT",
  );
});

void test("vendor, member, and customer responses use explicit key sets", async () => {
  const vendorId = await vendor();
  const owner = await user("Response owner");
  const customer = await user("Response customer");
  await membership(vendorId, owner, "vendor_owner");
  const customerMembershipId = await membership(vendorId, customer, "customer");
  await phone(customer);
  const ownerToken = await session(owner, "administrator_mfa");
  const customerToken = await session(customer, "phone_otp");
  const createdResponse = await api(
    `/v1/vendors/${vendorId}/households`,
    ownerToken,
    {
      method: "POST",
      body: {
        accountNumber: "KEYS",
        name: "Household",
        addressLine1: "Road",
        city: "City",
        region: "Region",
        postalCode: "12345",
        countryCode: "IN",
        notes: "Vendor only",
      },
    },
  );
  const household = (await createdResponse.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(household).sort(), [
    "accountNumber",
    "addressLine1",
    "city",
    "countryCode",
    "createdAt",
    "id",
    "lifecycle",
    "name",
    "notes",
    "postalCode",
    "region",
    "status",
    "updatedAt",
    "vendorId",
    "version",
  ]);
  const memberResponse = await api(
    `/v1/vendors/${vendorId}/households/${String(household.id)}/members`,
    ownerToken,
    { method: "POST", body: { customerMembershipId } },
  );
  const member = (await memberResponse.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(member).sort(), [
    "createdAt",
    "customerMembershipId",
    "displayName",
    "householdId",
    "id",
    "joinedAt",
    "phone",
    "status",
    "updatedAt",
    "userId",
  ]);
  const customerPage = (await (
    await api(`/v1/customer/vendors/${vendorId}/households`, customerToken)
  ).json()) as { items: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(customerPage.items[0]).sort(), [
    "accountNumber",
    "addressLine1",
    "city",
    "countryCode",
    "createdAt",
    "id",
    "name",
    "postalCode",
    "region",
    "status",
    "updatedAt",
    "vendorId",
    "version",
  ]);
});

void test("household authorization honors vendor lifecycle, actor role, and scoped read-only support", async () => {
  const activeVendor = await vendor();
  const onboardingVendor = await vendor("onboarding");
  const trialVendor = await vendor("trial");
  const suspendedVendor = await vendor("suspended");
  const closedVendor = await vendor("closed");
  const administrator = await user("Administrator");
  for (const vendorId of [
    activeVendor,
    onboardingVendor,
    trialVendor,
    suspendedVendor,
    closedVendor,
  ]) {
    await membership(vendorId, administrator, "vendor_administrator");
  }
  const administratorToken = await session(administrator, "administrator_mfa");
  const body = {
    accountNumber: "AUTH",
    name: "Household",
    addressLine1: "Road",
    city: "City",
    region: "Region",
    postalCode: "12345",
    countryCode: "IN",
  };
  for (const vendorId of [onboardingVendor, trialVendor]) {
    assert.equal(
      (await api(`/v1/vendors/${vendorId}/households`, administratorToken))
        .status,
      200,
    );
    assert.equal(
      (
        await api(`/v1/vendors/${vendorId}/households`, administratorToken, {
          method: "POST",
          body: { ...body, accountNumber: `AUTH-${vendorId}` },
        })
      ).status,
      201,
    );
  }
  for (const vendorId of [suspendedVendor, closedVendor]) {
    await expectError(
      await api(`/v1/vendors/${vendorId}/households`, administratorToken),
      403,
      "FORBIDDEN",
    );
  }
  const agent = await user("Agent");
  await membership(activeVendor, agent, "delivery_agent");
  const agentToken = await session(agent, "phone_otp");
  await expectError(
    await api(`/v1/vendors/${activeVendor}/households`, agentToken),
    403,
    "FORBIDDEN",
  );
  const platformUser = await user("Product owner");
  await ownerPool.query(
    `INSERT INTO platform_role_assignments (id,user_id,role,granted_by) VALUES ($1,$2,'product_owner',$2)`,
    [randomUUID(), platformUser],
  );
  await phone(platformUser);
  const platformToken = await session(platformUser, "administrator_mfa");
  await expectError(
    await api(`/v1/vendors/${activeVendor}/households`, platformToken),
    403,
    "FORBIDDEN",
  );
  const support = await user("Support");
  await ownerPool.query(
    `INSERT INTO platform_role_assignments (id,user_id,role,granted_by) VALUES ($1,$2,'support_operations',$2)`,
    [randomUUID(), support],
  );
  await phone(support);
  const supportToken = await session(support, "administrator_mfa");
  await expectError(
    await api(`/v1/vendors/${activeVendor}/households`, supportToken),
    403,
    "FORBIDDEN",
  );
  const created = await api(
    `/v1/vendors/${activeVendor}/households`,
    administratorToken,
    { method: "POST", body },
  );
  const household = (await created.json()) as HouseholdResponse;
  await ownerPool.query(
    `INSERT INTO support_access_grants (id,vendor_id,grantee_user_id,requested_by,approved_by,purpose,scope_json,access_mode,starts_at,expires_at)
     VALUES ($1,$2,$3,$3,$3,'Household support','["household:read"]'::jsonb,'read',now()-interval '1 minute',now()+interval '1 hour')`,
    [randomUUID(), activeVendor, support],
  );
  assert.equal(
    (await api(`/v1/vendors/${activeVendor}/households`, supportToken)).status,
    200,
  );
  assert.equal(
    (
      await api(
        `/v1/vendors/${activeVendor}/households/${household.id}`,
        supportToken,
      )
    ).status,
    200,
  );
  const mutationRequests = [
    api(`/v1/vendors/${activeVendor}/households`, supportToken, {
      method: "POST",
      body: { ...body, accountNumber: "DENIED" },
    }),
    api(
      `/v1/vendors/${activeVendor}/households/${household.id}`,
      supportToken,
      { method: "PATCH", body: { expectedVersion: 1, name: "Denied" } },
    ),
    api(
      `/v1/vendors/${activeVendor}/households/${household.id}`,
      supportToken,
      {
        method: "DELETE",
        body: { expectedVersion: 1, reason: "Denied mutation" },
      },
    ),
    api(
      `/v1/vendors/${activeVendor}/households/${household.id}/restore`,
      supportToken,
      {
        method: "POST",
        body: { expectedVersion: 1, reason: "Denied mutation" },
      },
    ),
    api(
      `/v1/vendors/${activeVendor}/households/${household.id}/members`,
      supportToken,
      { method: "POST", body: { customerMembershipId: randomUUID() } },
    ),
    api(
      `/v1/vendors/${activeVendor}/households/${household.id}/members/${randomUUID()}/end`,
      supportToken,
      { method: "POST", body: { reason: "Denied mutation" } },
    ),
  ];
  for (const response of await Promise.all(mutationRequests)) {
    await expectError(response, 403, "FORBIDDEN");
  }
});

void test("household attach rejects every ineligible customer membership neutrally", async () => {
  const vendorId = await vendor();
  const otherVendorId = await vendor();
  const owner = await user("Eligibility owner");
  await membership(vendorId, owner, "vendor_owner");
  const ownerToken = await session(owner, "administrator_mfa");
  const created = await api(`/v1/vendors/${vendorId}/households`, ownerToken, {
    method: "POST",
    body: {
      accountNumber: "ELIGIBILITY",
      name: "Household",
      addressLine1: "Road",
      city: "City",
      region: "Region",
      postalCode: "12345",
      countryCode: "IN",
    },
  });
  const household = (await created.json()) as HouseholdResponse;
  const wrongRoleUser = await user("Wrong role");
  const wrongRole = await membership(vendorId, wrongRoleUser, "delivery_agent");
  await phone(wrongRoleUser);
  const endedUser = await user("Ended");
  const ended = await membership(vendorId, endedUser, "customer", "ended");
  await phone(endedUser);
  const deletedUser = await user("Deleted membership");
  const deleted = await membership(vendorId, deletedUser, "customer");
  await phone(deletedUser);
  await ownerPool.query(
    "UPDATE vendor_memberships SET deleted_at=now() WHERE id=$1",
    [deleted],
  );
  const deactivatedUser = await user("Deactivated user");
  const deactivated = await membership(vendorId, deactivatedUser, "customer");
  await phone(deactivatedUser);
  await ownerPool.query(
    "UPDATE users SET status='deactivated',deactivated_at=now() WHERE id=$1",
    [deactivatedUser],
  );
  const deletedAccountUser = await user("Deleted user");
  const deletedAccount = await membership(
    vendorId,
    deletedAccountUser,
    "customer",
  );
  await phone(deletedAccountUser);
  await ownerPool.query("UPDATE users SET deleted_at=now() WHERE id=$1", [
    deletedAccountUser,
  ]);
  const unverifiedPhoneUser = await user("Unverified phone");
  const unverifiedPhone = await membership(
    vendorId,
    unverifiedPhoneUser,
    "customer",
  );
  await ownerPool.query(
    `INSERT INTO user_identities (id,user_id,type,normalized_value,verified_at,is_primary,updated_at)
     VALUES ($1,$2,'phone',$3,NULL,true,now())`,
    [randomUUID(), unverifiedPhoneUser, `+91${randomUUID().slice(0, 10)}`],
  );
  const nonPrimaryPhoneUser = await user("Non-primary phone");
  const nonPrimaryPhone = await membership(
    vendorId,
    nonPrimaryPhoneUser,
    "customer",
  );
  await ownerPool.query(
    `INSERT INTO user_identities (id,user_id,type,normalized_value,verified_at,is_primary,updated_at)
     VALUES ($1,$2,'phone',$3,now(),false,now())`,
    [randomUUID(), nonPrimaryPhoneUser, `+91${randomUUID().slice(0, 10)}`],
  );
  const otherUser = await user("Other vendor");
  const otherVendorMembership = await membership(
    otherVendorId,
    otherUser,
    "customer",
  );
  await phone(otherUser);
  for (const customerMembershipId of [
    wrongRole,
    ended,
    deleted,
    randomUUID(),
    deactivated,
    deletedAccount,
    unverifiedPhone,
    nonPrimaryPhone,
    otherVendorMembership,
  ]) {
    await expectError(
      await api(
        `/v1/vendors/${vendorId}/households/${household.id}/members`,
        ownerToken,
        { method: "POST", body: { customerMembershipId } },
      ),
      404,
      "CUSTOMER_MEMBERSHIP_NOT_FOUND",
    );
  }
});

void test("audit append failure rolls back every household mutation", async () => {
  const vendorId = await vendor();
  const owner = await user("Rollback owner");
  const customer = await user("Rollback customer");
  await membership(vendorId, owner, "vendor_owner");
  const customerMembershipId = await membership(vendorId, customer, "customer");
  await phone(customer);
  const token = await session(owner, "administrator_mfa");
  const body = {
    name: "Rollback household",
    addressLine1: "Road",
    city: "City",
    region: "Region",
    postalCode: "12345",
    countryCode: "IN",
  };
  const createHousehold = async (accountNumber: string) => {
    const response = await api(`/v1/vendors/${vendorId}/households`, token, {
      method: "POST",
      body: { ...body, accountNumber },
    });
    assert.equal(response.status, 201);
    return (await response.json()) as HouseholdResponse;
  };
  const updateTarget = await createHousehold("ROLLBACK-UPDATE");
  const deleteTarget = await createHousehold("ROLLBACK-DELETE");
  const restoreTarget = await createHousehold("ROLLBACK-RESTORE");
  const attachTarget = await createHousehold("ROLLBACK-ATTACH");
  const endTarget = await createHousehold("ROLLBACK-END");
  assert.equal(
    (
      await api(
        `/v1/vendors/${vendorId}/households/${restoreTarget.id}`,
        token,
        {
          method: "DELETE",
          body: { expectedVersion: 1, reason: "Prepare restore rollback" },
        },
      )
    ).status,
    204,
  );
  const attachedResponse = await api(
    `/v1/vendors/${vendorId}/households/${endTarget.id}/members`,
    token,
    { method: "POST", body: { customerMembershipId } },
  );
  assert.equal(attachedResponse.status, 201);
  const endMember = (await attachedResponse.json()) as { id: string };
  const householdIds = [updateTarget.id, deleteTarget.id, restoreTarget.id];
  const householdSnapshot = await ownerPool.query(
    `SELECT id,name,version,status,deleted_at,deleted_by,deletion_reason
     FROM households WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [householdIds],
  );
  const memberSnapshot = await ownerPool.query(
    `SELECT id,status,ended_at,updated_at FROM household_members WHERE id=$1`,
    [endMember.id],
  );
  const suffix = randomUUID().replaceAll("-", "");
  const trigger = `reject_household_audit_${suffix}`;
  const triggerFunction = `reject_household_audit_fn_${suffix}`;
  try {
    await ownerPool.query(
      `CREATE FUNCTION ${triggerFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.action = ANY(ARRAY[
           'household.created', 'household.updated', 'household.deleted',
           'household.restored', 'household.member_attached', 'household.member_ended'
         ]) THEN
           RAISE EXCEPTION 'forced household audit failure';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await ownerPool.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events
       FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}()`,
    );
    const failedCreateAccount = `ROLLBACK-CREATE-${suffix.slice(0, 8)}`;
    for (const response of [
      await api(`/v1/vendors/${vendorId}/households`, token, {
        method: "POST",
        body: { ...body, accountNumber: failedCreateAccount },
      }),
      await api(
        `/v1/vendors/${vendorId}/households/${updateTarget.id}`,
        token,
        {
          method: "PATCH",
          body: { expectedVersion: 1, name: "Must roll back" },
        },
      ),
      await api(
        `/v1/vendors/${vendorId}/households/${deleteTarget.id}`,
        token,
        {
          method: "DELETE",
          body: { expectedVersion: 1, reason: "Must roll back delete" },
        },
      ),
      await api(
        `/v1/vendors/${vendorId}/households/${restoreTarget.id}/restore`,
        token,
        {
          method: "POST",
          body: { expectedVersion: 2, reason: "Must roll back restore" },
        },
      ),
      await api(
        `/v1/vendors/${vendorId}/households/${attachTarget.id}/members`,
        token,
        { method: "POST", body: { customerMembershipId } },
      ),
      await api(
        `/v1/vendors/${vendorId}/households/${endTarget.id}/members/${endMember.id}/end`,
        token,
        { method: "POST", body: { reason: "Must roll back end" } },
      ),
    ])
      await expectError(response, 500, "INTERNAL_ERROR");
    assert.equal(
      (
        await ownerPool.query(
          "SELECT id FROM households WHERE vendor_id=$1 AND account_number=$2",
          [vendorId, failedCreateAccount],
        )
      ).rowCount,
      0,
    );
    assert.deepEqual(
      (
        await ownerPool.query(
          `SELECT id,name,version,status,deleted_at,deleted_by,deletion_reason
           FROM households WHERE id=ANY($1::uuid[]) ORDER BY id`,
          [householdIds],
        )
      ).rows,
      householdSnapshot.rows,
    );
    assert.equal(
      (
        await ownerPool.query(
          `SELECT id FROM household_members
           WHERE household_id=$1 AND customer_membership_id=$2`,
          [attachTarget.id, customerMembershipId],
        )
      ).rowCount,
      0,
    );
    assert.deepEqual(
      (
        await ownerPool.query(
          `SELECT id,status,ended_at,updated_at
           FROM household_members WHERE id=$1`,
          [endMember.id],
        )
      ).rows,
      memberSnapshot.rows,
    );
  } finally {
    await ownerPool.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit_events`);
    await ownerPool.query(`DROP FUNCTION IF EXISTS ${triggerFunction}()`);
  }
});

void test("duplicate attach and repeated or missing member end return stable conflicts", async () => {
  const vendorId = await vendor();
  const owner = await user("Conflict owner");
  const customer = await user("Conflict customer");
  await membership(vendorId, owner, "vendor_owner");
  const customerMembershipId = await membership(vendorId, customer, "customer");
  await phone(customer);
  const token = await session(owner, "administrator_mfa");
  const created = await api(`/v1/vendors/${vendorId}/households`, token, {
    method: "POST",
    body: {
      accountNumber: "LINK-CONFLICT",
      name: "Household",
      addressLine1: "Road",
      city: "City",
      region: "Region",
      postalCode: "12345",
      countryCode: "IN",
    },
  });
  const household = (await created.json()) as HouseholdResponse;
  const attached = await api(
    `/v1/vendors/${vendorId}/households/${household.id}/members`,
    token,
    { method: "POST", body: { customerMembershipId } },
  );
  const member = (await attached.json()) as { id: string };
  await expectError(
    await api(
      `/v1/vendors/${vendorId}/households/${household.id}/members`,
      token,
      { method: "POST", body: { customerMembershipId } },
    ),
    409,
    "HOUSEHOLD_CONFLICT",
  );
  assert.equal(
    (
      await api(
        `/v1/vendors/${vendorId}/households/${household.id}/members/${member.id}/end`,
        token,
        { method: "POST", body: { reason: "End membership" } },
      )
    ).status,
    200,
  );
  for (const memberId of [member.id, randomUUID()]) {
    await expectError(
      await api(
        `/v1/vendors/${vendorId}/households/${household.id}/members/${memberId}/end`,
        token,
        { method: "POST", body: { reason: "End membership" } },
      ),
      409,
      "HOUSEHOLD_MEMBER_STATE_CONFLICT",
    );
  }
});

void test("household lifecycle discovery separates current and deleted records", async () => {
  const vendorId = await vendor();
  const otherVendorId = await vendor();
  const owner = await user("Lifecycle owner");
  const otherOwner = await user("Other lifecycle owner");
  await membership(vendorId, owner, "vendor_owner");
  await membership(otherVendorId, otherOwner, "vendor_owner");
  const token = await session(owner, "administrator_mfa");
  const otherToken = await session(otherOwner, "administrator_mfa");
  const body = {
    name: "Lifecycle household",
    addressLine1: "12 Market Road",
    city: "Ahmedabad",
    region: "Gujarat",
    postalCode: "380001",
    countryCode: "IN",
  };
  const create = async (
    currentVendorId: string,
    currentToken: string,
    accountNumber: string,
  ) => {
    const response = await api(
      `/v1/vendors/${currentVendorId}/households`,
      currentToken,
      { method: "POST", body: { ...body, accountNumber } },
    );
    assert.equal(response.status, 201);
    const value = (await response.json()) as HouseholdResponse;
    assert.equal(value.lifecycle, "current");
    assert.equal("deletedAt" in value, false);
    assert.equal("deletedBy" in value, false);
    assert.equal("deletionReason" in value, false);
    return value;
  };
  const active = await create(vendorId, token, "LC-ACTIVE");
  const inactiveCreated = await create(vendorId, token, "LC-INACTIVE");
  const secondDeleted = await create(vendorId, token, "LC-SECOND");
  const foreign = await create(otherVendorId, otherToken, "LC-FOREIGN");

  const inactiveResponse = await api(
    `/v1/vendors/${vendorId}/households/${inactiveCreated.id}`,
    token,
    {
      method: "PATCH",
      body: { expectedVersion: inactiveCreated.version, status: "inactive" },
    },
  );
  assert.equal(inactiveResponse.status, 200);
  const inactive = (await inactiveResponse.json()) as HouseholdResponse;
  assert.equal(inactive.lifecycle, "current");
  assert.equal(inactive.status, "inactive");

  const currentDefault = await api(
    `/v1/vendors/${vendorId}/households`,
    token,
  );
  assert.equal(currentDefault.status, 200);
  const currentItems = (
    (await currentDefault.json()) as { items: HouseholdResponse[] }
  ).items;
  assert.ok(currentItems.some(({ id }) => id === active.id));
  assert.ok(currentItems.some(({ id }) => id === secondDeleted.id));
  assert.equal(currentItems.some(({ id }) => id === inactive.id), false);
  assert.ok(currentItems.every(({ lifecycle }) => lifecycle === "current"));

  const inactiveList = await api(
    `/v1/vendors/${vendorId}/households?status=inactive`,
    token,
  );
  assert.deepEqual(
    ((await inactiveList.json()) as { items: HouseholdResponse[] }).items.map(
      ({ id }) => id,
    ),
    [inactive.id],
  );
  const inactiveDetail = await api(
    `/v1/vendors/${vendorId}/households/${inactive.id}`,
    token,
  );
  assert.equal(inactiveDetail.status, 200);
  assert.equal(
    ((await inactiveDetail.json()) as HouseholdResponse).lifecycle,
    "current",
  );
  await expectError(
    await api(`/v1/vendors/${vendorId}/households?lifecycle=all`, token),
    400,
  );

  for (const value of [inactive, secondDeleted]) {
    const response = await api(
      `/v1/vendors/${vendorId}/households/${value.id}`,
      token,
      {
        method: "DELETE",
        body: { expectedVersion: value.version, reason: "Lifecycle removal" },
      },
    );
    assert.equal(response.status, 204);
  }

  await expectError(
    await api(`/v1/vendors/${vendorId}/households/${inactive.id}`, token),
    404,
    "HOUSEHOLD_NOT_FOUND",
  );
  await expectError(
    await api(
      `/v1/vendors/${vendorId}/households/${active.id}?lifecycle=deleted`,
      token,
    ),
    404,
    "HOUSEHOLD_NOT_FOUND",
  );

  const deletedDefault = await api(
    `/v1/vendors/${vendorId}/households?lifecycle=deleted`,
    token,
  );
  assert.equal(deletedDefault.status, 200);
  const deletedItems = (
    (await deletedDefault.json()) as { items: HouseholdResponse[] }
  ).items;
  assert.deepEqual(
    new Set(deletedItems.map(({ id }) => id)),
    new Set([inactive.id, secondDeleted.id]),
  );
  assert.ok(deletedItems.every(({ lifecycle }) => lifecycle === "deleted"));
  assert.ok(
    deletedItems.every(
      (value) =>
        !("deletedAt" in value) &&
        !("deletedBy" in value) &&
        !("deletionReason" in value),
    ),
  );

  const deletedInactive = await api(
    `/v1/vendors/${vendorId}/households?lifecycle=deleted&status=inactive`,
    token,
  );
  assert.deepEqual(
    ((await deletedInactive.json()) as { items: HouseholdResponse[] }).items.map(
      ({ id }) => id,
    ),
    [inactive.id],
  );
  const deletedActive = await api(
    `/v1/vendors/${vendorId}/households?lifecycle=deleted&status=active`,
    token,
  );
  assert.deepEqual(
    ((await deletedActive.json()) as { items: HouseholdResponse[] }).items.map(
      ({ id }) => id,
    ),
    [secondDeleted.id],
  );

  const firstPage = await api(
    `/v1/vendors/${vendorId}/households?lifecycle=deleted&limit=1`,
    token,
  );
  const firstPageBody = (await firstPage.json()) as {
    items: HouseholdResponse[];
    nextCursor?: string;
  };
  assert.equal(firstPageBody.items.length, 1);
  assert.ok(firstPageBody.nextCursor);
  const nextPage = await api(
    `/v1/vendors/${vendorId}/households?lifecycle=deleted&limit=1&cursor=${encodeURIComponent(firstPageBody.nextCursor)}`,
    token,
  );
  const nextItems = (
    (await nextPage.json()) as { items: HouseholdResponse[] }
  ).items;
  assert.equal(nextItems.length, 1);
  assert.notEqual(nextItems[0]?.id, firstPageBody.items[0]?.id);

  const deletedDetailResponse = await api(
    `/v1/vendors/${vendorId}/households/${inactive.id}?lifecycle=deleted`,
    token,
  );
  assert.equal(deletedDetailResponse.status, 200);
  const deletedDetail =
    (await deletedDetailResponse.json()) as HouseholdResponse;
  assert.equal(deletedDetail.version, inactive.version + 1);
  assert.equal(deletedDetail.lifecycle, "deleted");
  assert.equal("deletedAt" in deletedDetail, false);

  await expectError(
    await api(
      `/v1/vendors/${vendorId}/households/${inactive.id}/restore`,
      token,
      {
        method: "POST",
        body: {
          expectedVersion: inactive.version,
          reason: "Stale lifecycle restore",
        },
      },
    ),
    409,
    "HOUSEHOLD_VERSION_CONFLICT",
  );
  const restoredResponse = await api(
    `/v1/vendors/${vendorId}/households/${inactive.id}/restore`,
    token,
    {
      method: "POST",
      body: {
        expectedVersion: deletedDetail.version,
        reason: "Restore lifecycle household",
      },
    },
  );
  assert.equal(restoredResponse.status, 200);
  const restored = (await restoredResponse.json()) as HouseholdResponse;
  assert.equal(restored.lifecycle, "current");
  assert.equal(restored.status, "inactive");
  assert.equal(
    (
      await api(
        `/v1/vendors/${vendorId}/households/${inactive.id}`,
        token,
      )
    ).status,
    200,
  );
  await expectError(
    await api(
      `/v1/vendors/${vendorId}/households/${inactive.id}?lifecycle=deleted`,
      token,
    ),
    404,
    "HOUSEHOLD_NOT_FOUND",
  );

  await expectError(
    await api(
      `/v1/vendors/${otherVendorId}/households?lifecycle=deleted`,
      token,
    ),
    403,
    "FORBIDDEN",
  );
  await expectError(
    await api(
      `/v1/vendors/${vendorId}/households/${foreign.id}`,
      token,
    ),
    404,
    "HOUSEHOLD_NOT_FOUND",
  );
});
