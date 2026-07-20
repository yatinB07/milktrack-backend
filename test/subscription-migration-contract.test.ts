import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = new URL('../prisma/migrations/202607200005_subscriptions/migration.sql', import.meta.url);

void test('subscription migration encodes retained tenant-safe aggregate history', async () => {
  const sql = await readFile(migration, 'utf8');
  for (const table of ['subscriptions', 'subscription_revisions', 'subscription_revision_weekdays']) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table} \\(`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /subscription_revisions_supersession_fkey[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /FOREIGN KEY \(vendor_id, subscription_id, superseded_by_revision_id\)[\s\S]*REFERENCES subscription_revisions\(vendor_id, subscription_id, id\)/);
  assert.match(sql, /subscription_revisions_no_current_plan_overlap[\s\S]*WHERE \(superseded_at IS NULL\)/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER subscription_revision_weekdays_nonempty[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /GRANT SELECT, INSERT ON subscriptions, subscription_revisions, subscription_revision_weekdays TO milktrack_app/);
  assert.match(sql, /GRANT UPDATE \(version, deleted_at, deleted_by, deletion_reason, updated_at\) ON subscriptions TO milktrack_app/);
  assert.match(sql, /GRANT UPDATE \(effective_to, superseded_at, superseded_by_revision_id, supersession_reason, updated_at\)[\s\S]*subscription_revisions TO milktrack_app/);
  assert.doesNotMatch(sql, /GRANT[^;]*DELETE[^;]*subscription/);
});

void test('subscription migration preserves narrow lifecycle and quantity constraints', async () => {
  const sql = await readFile(migration, 'utf8');
  for (const constraint of [
    'subscriptions_version_check', 'subscriptions_deletion_check',
    'subscription_revisions_quantity_check', 'subscription_revisions_status_check',
    'subscription_revisions_effective_period_check', 'subscription_revisions_supersession_check',
    'subscription_revision_weekdays_weekday_check',
  ]) assert.match(sql, new RegExp(`CONSTRAINT ${constraint}`));
  assert.match(sql, /quantity NUMERIC\(18,3\) NOT NULL/);
  assert.match(sql, /status TEXT NOT NULL/);
  assert.match(sql, /status IN \('active', 'paused', 'cancelled'\)/);
  assert.doesNotMatch(sql, /(?:DROP|TRUNCATE)\s+(?:TABLE\s+)?(?:households|products|units|delivery_slots|global_prices|customer_price_overrides)/i);
});
