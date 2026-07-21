import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';

import { TenantTransactionRunner } from '../src/common/application/transaction-context.js';
import { unwrapPrismaTransaction } from '../src/database/infrastructure/prisma-transaction-context.js';
import {
  ScheduleGenerator,
  type ScheduleGenerationResult,
} from '../src/scheduling/application/schedule-generator.js';
import { ScheduleGenerationModule } from '../src/scheduling/schedule-generation.module.js';

if (process.env.P2_VOLUME_GATE !== '1') {
  throw new Error('P2_VOLUME_GATE=1 is required');
}

const VENDOR_COUNT = 200;
const CUSTOMER_COUNT = 100_000;
const SUBSCRIPTION_COUNT = 200_000;
const DELIVERIES_PER_VENDOR = 1_000;
const WORKER_COUNT = 8;
const SERVICE_DATE = '2030-01-07';
const ACTOR_ID = '90000000-0000-4000-8000-000000000001';

type GenerationAccumulator = {
  -readonly [Key in keyof ScheduleGenerationResult]: ScheduleGenerationResult[Key];
};

const emptyResult = (): GenerationAccumulator => ({
  created: 0,
  existing: 0,
  updated: 0,
  cancelled: 0,
  missingPrice: 0,
});

const vendorId = (number: number) =>
  `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

const owner = new pg.Pool({
  connectionString: process.env.TEST_OWNER_DATABASE_URL,
});
let app: INestApplicationContext | undefined;
const startedAt = performance.now();

try {
  const before = await fixtureCounts();
  assert.deepEqual(before, {
    vendors: '0',
    customers: '0',
    activeSubscriptions: '0',
  });

  const fixtureStartedAt = performance.now();
  await seedFixtures();
  const fixtureMs = performance.now() - fixtureStartedAt;
  console.info(`fixtures complete: ${Math.round(fixtureMs)}ms`);
  assert.deepEqual(await fixtureCounts(), {
    vendors: String(VENDOR_COUNT),
    customers: String(CUSTOMER_COUNT),
    activeSubscriptions: String(SUBSCRIPTION_COUNT),
  });
  await assertFixtureIntegrity();

  app = await NestFactory.createApplicationContext(ScheduleGenerationModule, {
    logger: false,
  });
  const generator = app.get(ScheduleGenerator);
  const transactions = app.get(TenantTransactionRunner);
  const vendorIds = Array.from({ length: VENDOR_COUNT }, (_, index) =>
    vendorId(index + 1),
  );

  const firstStartedAt = performance.now();
  const firstPass = await generatePass('first', generator, transactions, vendorIds);
  const firstPassMs = performance.now() - firstStartedAt;
  assert.deepEqual(firstPass, {
    created: SUBSCRIPTION_COUNT,
    existing: 0,
    updated: 0,
    cancelled: 0,
    missingPrice: 0,
  });

  const secondStartedAt = performance.now();
  const secondPass = await generatePass('second', generator, transactions, vendorIds);
  const secondPassMs = performance.now() - secondStartedAt;
  assert.deepEqual(secondPass, {
    created: 0,
    existing: SUBSCRIPTION_COUNT,
    updated: 0,
    cancelled: 0,
    missingPrice: 0,
  });

  const database = await databaseAssertions();
  const rls = {
    first: await visibleDeliveryCount(transactions, vendorId(1)),
    middle: await visibleDeliveryCount(transactions, vendorId(100)),
    last: await visibleDeliveryCount(transactions, vendorId(200)),
  };
  assert.deepEqual(rls, {
    first: DELIVERIES_PER_VENDOR,
    middle: DELIVERIES_PER_VENDOR,
    last: DELIVERIES_PER_VENDOR,
  });

  console.info(
    JSON.stringify({
      fixtureMs: Math.round(fixtureMs),
      firstPassMs: Math.round(firstPassMs),
      firstPass,
      secondPassMs: Math.round(secondPassMs),
      secondPass,
      ...database,
      rls,
      totalMs: Math.round(performance.now() - startedAt),
    }),
  );
} finally {
  await app?.close();
  await owner.end();
}

async function fixtureCounts() {
  const counts = await owner.query<{
    vendors: string;
    customers: string;
    activeSubscriptions: string;
  }>(`
    SELECT
      (SELECT count(*) FROM vendors)::text AS vendors,
      (SELECT count(*) FROM households)::text AS customers,
      (SELECT count(*) FROM subscription_revisions
       WHERE status = 'active' AND superseded_at IS NULL)::text
        AS "activeSubscriptions"
  `);
  return counts.rows[0];
}

async function seedFixtures() {
  await owner.query(`
    INSERT INTO users (id, display_name, updated_at)
    VALUES ('${ACTOR_ID}'::uuid, 'Volume gate actor', CURRENT_TIMESTAMP)
  `);
  await owner.query(`
    BEGIN;
    ALTER TABLE subscription_revisions
      DISABLE TRIGGER subscription_revisions_weekdays_nonempty;
    ALTER TABLE subscription_revision_weekdays
      DISABLE TRIGGER subscription_revision_weekdays_nonempty;
    COMMIT
  `);
  try {
    const rangeSize = Math.ceil(VENDOR_COUNT / WORKER_COUNT);
    await Promise.all(
      Array.from({ length: WORKER_COUNT }, (_, index) => {
        const startVendor = index * rangeSize + 1;
        const endVendor = Math.min(startVendor + rangeSize - 1, VENDOR_COUNT);
        return seedVendorRange(startVendor, endVendor);
      }),
    );
  } finally {
    await owner.query(`
      BEGIN;
      ALTER TABLE subscription_revisions
        ENABLE TRIGGER subscription_revisions_weekdays_nonempty;
      ALTER TABLE subscription_revision_weekdays
        ENABLE TRIGGER subscription_revision_weekdays_nonempty;
      COMMIT
    `);
  }
}

async function seedVendorRange(startVendor: number, endVendor: number) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `
        INSERT INTO vendors (
          id, code, legal_name, display_name, status, timezone, currency,
          skip_cutoff_minutes, billing_day, updated_at
        )
        SELECT
          ('10000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          'VOL_' || lpad(v::text, 6, '0'),
          'Volume Vendor ' || v,
          'Volume Vendor ' || v,
          'active', 'UTC', 'USD', 60, 1, CURRENT_TIMESTAMP
        FROM generate_series(${startVendor}, ${endVendor}) AS v;

        INSERT INTO units (id, vendor_id, code, name, decimal_scale, updated_at)
        SELECT
          ('20000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          ('10000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          'LITRE', 'Litre', 3, CURRENT_TIMESTAMP
        FROM generate_series(${startVendor}, ${endVendor}) AS v;

        INSERT INTO products (id, vendor_id, code, name, default_unit_id, updated_at)
        SELECT
          ('30000000-0000-4000-8000-' || lpad(((v - 1) * 2 + p)::text, 12, '0'))::uuid,
          ('10000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          'MILK_' || p,
          'Volume Milk ' || p,
          ('20000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          CURRENT_TIMESTAMP
        FROM generate_series(${startVendor}, ${endVendor}) AS v
        CROSS JOIN generate_series(1, 2) AS p;

        INSERT INTO delivery_slots (
          id, vendor_id, code, name, start_local_time, end_local_time, updated_at
        )
        SELECT
          ('40000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          ('10000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          'MORNING', 'Morning', TIME '06:00:00', TIME '09:00:00', CURRENT_TIMESTAMP
        FROM generate_series(${startVendor}, ${endVendor}) AS v;

        INSERT INTO households (
          id, vendor_id, account_number, name, address_line_1, city, region,
          postal_code, country_code, updated_at
        )
        SELECT
          ('50000000-0000-4000-8000-' || lpad(((v - 1) * 500 + h)::text, 12, '0'))::uuid,
          ('10000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          'C' || lpad(((v - 1) * 500 + h)::text, 9, '0'),
          'Volume Customer ' || ((v - 1) * 500 + h),
          h || ' Volume Street', 'Volume City', 'Volume Region', '000001', 'US',
          CURRENT_TIMESTAMP
        FROM generate_series(${startVendor}, ${endVendor}) AS v
        CROSS JOIN generate_series(1, 500) AS h;

        INSERT INTO subscriptions (id, vendor_id, household_id, updated_at)
        SELECT
          ('60000000-0000-4000-8000-' || lpad((((v - 1) * 500 + h - 1) * 2 + p)::text, 12, '0'))::uuid,
          ('10000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          ('50000000-0000-4000-8000-' || lpad(((v - 1) * 500 + h)::text, 12, '0'))::uuid,
          CURRENT_TIMESTAMP
        FROM generate_series(${startVendor}, ${endVendor}) AS v
        CROSS JOIN generate_series(1, 500) AS h
        CROSS JOIN generate_series(1, 2) AS p;

        INSERT INTO subscription_revisions (
          id, vendor_id, subscription_id, product_id, unit_id, delivery_slot_id,
          quantity, status, effective_from, created_by, updated_at
        )
        SELECT
          ('70000000-0000-4000-8000-' || lpad((((v - 1) * 500 + h - 1) * 2 + p)::text, 12, '0'))::uuid,
          ('10000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          ('60000000-0000-4000-8000-' || lpad((((v - 1) * 500 + h - 1) * 2 + p)::text, 12, '0'))::uuid,
          ('30000000-0000-4000-8000-' || lpad(((v - 1) * 2 + p)::text, 12, '0'))::uuid,
          ('20000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          ('40000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          1.000, 'active', DATE '2029-01-01', '${ACTOR_ID}'::uuid, CURRENT_TIMESTAMP
        FROM generate_series(${startVendor}, ${endVendor}) AS v
        CROSS JOIN generate_series(1, 500) AS h
        CROSS JOIN generate_series(1, 2) AS p;

        INSERT INTO subscription_revision_weekdays (
          vendor_id, subscription_revision_id, weekday
        )
        SELECT
          ('10000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          ('70000000-0000-4000-8000-' || lpad((((v - 1) * 500 + h - 1) * 2 + p)::text, 12, '0'))::uuid,
          EXTRACT(ISODOW FROM DATE '${SERVICE_DATE}')::smallint
        FROM generate_series(${startVendor}, ${endVendor}) AS v
        CROSS JOIN generate_series(1, 500) AS h
        CROSS JOIN generate_series(1, 2) AS p;

        INSERT INTO global_prices (
          id, vendor_id, product_id, unit_id, amount_minor, currency,
          effective_from, created_by, updated_at
        )
        SELECT
          ('80000000-0000-4000-8000-' || lpad(((v - 1) * 2 + p)::text, 12, '0'))::uuid,
          ('10000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          ('30000000-0000-4000-8000-' || lpad(((v - 1) * 2 + p)::text, 12, '0'))::uuid,
          ('20000000-0000-4000-8000-' || lpad(v::text, 12, '0'))::uuid,
          100, 'USD', TIMESTAMPTZ '2029-01-01 00:00:00+00', '${ACTOR_ID}'::uuid,
          CURRENT_TIMESTAMP
        FROM generate_series(${startVendor}, ${endVendor}) AS v
        CROSS JOIN generate_series(1, 2) AS p
      `,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function assertFixtureIntegrity() {
  const missingWeekdays = await owner.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM subscription_revisions revision
    WHERE NOT EXISTS (
      SELECT 1
      FROM subscription_revision_weekdays weekday
      WHERE weekday.vendor_id = revision.vendor_id
        AND weekday.subscription_revision_id = revision.id
    )
  `);
  assert.equal(missingWeekdays.rows[0]?.count, '0');

  const triggers = await owner.query<{ name: string; enabled: string }>(`
    SELECT tgname AS name, tgenabled AS enabled
    FROM pg_trigger
    WHERE tgname IN (
      'subscription_revisions_weekdays_nonempty',
      'subscription_revision_weekdays_nonempty'
    )
    ORDER BY tgname
  `);
  assert.deepEqual(triggers.rows, [
    { name: 'subscription_revision_weekdays_nonempty', enabled: 'O' },
    { name: 'subscription_revisions_weekdays_nonempty', enabled: 'O' },
  ]);
}

async function generatePass(
  label: string,
  generator: ScheduleGenerator,
  transactions: TenantTransactionRunner,
  vendorIds: readonly string[],
) {
  const total = emptyResult();
  let nextVendor = 0;
  let completedVendors = 0;
  await Promise.all(
    Array.from({ length: WORKER_COUNT }, async () => {
      while (nextVendor < vendorIds.length) {
        const current = vendorIds[nextVendor];
        nextVendor += 1;
        assert.ok(current);
        const result = await transactions.run(current, (transaction) =>
          generator.generate(transaction, current, SERVICE_DATE),
        );
        total.created += result.created;
        total.existing += result.existing;
        total.updated += result.updated;
        total.cancelled += result.cancelled;
        total.missingPrice += result.missingPrice;
        completedVendors += 1;
        if (completedVendors % 25 === 0) {
          console.info(`${label} pass vendors complete: ${completedVendors}`);
        }
      }
    }),
  );
  return total;
}

async function databaseAssertions() {
  const total = await owner.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM scheduled_deliveries',
  );
  assert.equal(total.rows[0]?.count, String(SUBSCRIPTION_COUNT));

  const groups = await owner.query<{ vendorId: string; count: string }>(`
    SELECT vendor_id AS "vendorId", count(*)::text AS count
    FROM scheduled_deliveries
    GROUP BY vendor_id
    ORDER BY vendor_id
  `);
  assert.equal(groups.rowCount, VENDOR_COUNT);
  assert.ok(
    groups.rows.every(({ count }) => count === String(DELIVERIES_PER_VENDOR)),
  );

  const duplicates = await owner.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM (
      SELECT vendor_id, subscription_id, service_date, delivery_slot_id
      FROM scheduled_deliveries
      GROUP BY vendor_id, subscription_id, service_date, delivery_slot_id
      HAVING count(*) > 1
    ) AS duplicate_keys
  `);
  assert.equal(duplicates.rows[0]?.count, '0');

  const routes = await owner.query<{
    routes: string;
    agents: string;
    assignments: string;
  }>(`
    SELECT
      (SELECT count(*) FROM routes)::text AS routes,
      (SELECT count(*) FROM vendor_memberships
       WHERE role = 'delivery_agent')::text AS agents,
      (SELECT count(*) FROM route_assignments)::text AS assignments
  `);
  assert.deepEqual(routes.rows[0], {
    routes: '0',
    agents: '0',
    assignments: '0',
  });

  return {
    totalRows: Number(total.rows[0]?.count),
    vendorGroups: groups.rowCount,
    rowsPerVendor: DELIVERIES_PER_VENDOR,
    duplicateBusinessKeys: Number(duplicates.rows[0]?.count),
    routes: Number(routes.rows[0]?.routes),
    agents: Number(routes.rows[0]?.agents),
    assignments: Number(routes.rows[0]?.assignments),
  };
}

async function visibleDeliveryCount(
  transactions: TenantTransactionRunner,
  scopedVendorId: string,
) {
  return transactions.run(scopedVendorId, async (transaction) => {
    const rows = await unwrapPrismaTransaction(transaction).$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) AS count FROM scheduled_deliveries`;
    return Number(rows[0]?.count);
  });
}
