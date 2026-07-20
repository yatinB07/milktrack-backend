import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  SCHEDULE_GENERATION_FAILURE_CODE_MAX_LENGTH,
  SCHEDULE_GENERATION_FAILURE_MESSAGE_MAX_LENGTH,
  SCHEDULE_GENERATION_LEASE_SECONDS,
  SCHEDULE_GENERATION_MAX_ATTEMPTS,
  SCHEDULE_GENERATION_RETRY_BACKOFF_SECONDS,
  SCHEDULE_GENERATION_RETRY_BACKOFF_CAP_SECONDS,
} from '../src/scheduling/domain/schedule-generation-run.js';
import { ScheduleGenerationRunStore } from '../src/scheduling/application/schedule-generation-run.store.js';
import { ScheduleRunProcessor } from '../src/scheduling/application/schedule-run-processor.js';
import { ScheduleRegenerationWriter } from '../src/schedule-coordination/application/schedule-regeneration-writer.js';

void test('schedule generation run migration freezes the durable fenced ledger', async () => {
  const sql = await readFile(new URL('../prisma/migrations/202607200010_schedule_generation_runs/migration.sql', import.meta.url), 'utf8');
  for (const fragment of [
    'CREATE TABLE schedule_generation_runs',
    "trigger IN ('automatic','manual','configuration_change')",
    "status IN ('queued','running','retry_wait','succeeded','failed')",
    'max_attempts INTEGER NOT NULL DEFAULT 5',
    'attempt_count BETWEEN 0 AND max_attempts',
    'schedule_generation_runs_automatic_key',
    "WHERE trigger = 'automatic'",
    'schedule_generation_runs_open_configuration_key',
    "WHERE trigger = 'configuration_change' AND status IN ('queued','running','retry_wait')",
    'schedule_generation_runs_due_claim_idx',
    'schedule_generation_runs_cursor_idx',
    'ON schedule_generation_runs (vendor_id, created_at DESC, id DESC)',
    'ENABLE ROW LEVEL SECURITY',
    'FORCE ROW LEVEL SECURITY',
    'GRANT SELECT, INSERT',
    'GRANT UPDATE (',
  ]) assert.ok(sql.includes(fragment), `migration must include ${fragment}`);
  assert.doesNotMatch(sql, /GRANT DELETE|CREATE TABLE delivery_events|CREATE TABLE idempotency_records/u);
});

void test('Prisma and application contracts publish only the S2 prerequisite', async () => {
  const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const store = await readFile(new URL('../src/scheduling/application/schedule-generation-run.store.ts', import.meta.url), 'utf8');
  const processor = await readFile(new URL('../src/scheduling/application/schedule-run-processor.ts', import.meta.url), 'utf8');
  const writer = await readFile(new URL('../src/schedule-coordination/application/schedule-regeneration-writer.ts', import.meta.url), 'utf8');
  assert.match(schema, /model ScheduleGenerationRun \{/u);
  assert.match(schema, /@@index\(\[vendorId, createdAt\(sort: Desc\), id\(sort: Desc\)\]\)/u);
  for (const operation of ['createAndClaimManual', 'claimNext', 'renew', 'succeed', 'fail', 'list']) {
    assert.match(store, new RegExp(`abstract ${operation}\\(`, 'u'));
  }
  assert.match(processor, /abstract process\(/u);
  assert.match(writer, /abstract write\(/u);
  assert.equal(typeof ScheduleGenerationRunStore, 'function');
  assert.equal(typeof ScheduleRunProcessor, 'function');
  assert.equal(typeof ScheduleRegenerationWriter, 'function');
});

void test('schedule generation constants match the frozen retry contract', () => {
  assert.equal(SCHEDULE_GENERATION_MAX_ATTEMPTS, 5);
  assert.equal(SCHEDULE_GENERATION_LEASE_SECONDS, 60);
  assert.deepEqual(SCHEDULE_GENERATION_RETRY_BACKOFF_SECONDS, [5, 10, 20, 40]);
  assert.equal(SCHEDULE_GENERATION_RETRY_BACKOFF_CAP_SECONDS, 300);
  assert.equal(SCHEDULE_GENERATION_FAILURE_CODE_MAX_LENGTH, 128);
  assert.equal(SCHEDULE_GENERATION_FAILURE_MESSAGE_MAX_LENGTH, 500);
});
