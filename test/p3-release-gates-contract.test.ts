import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('Phase 3 retains isolated database gates and excludes deferred tables', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  const schema = await readFile('prisma/schema.prisma', 'utf8');
  assert.equal(packageJson.scripts['test:integration'], 'sh test/integration-release.sh');
  assert.equal(packageJson.scripts['test:security'], 'sh test/security-release.sh');
  assert.match(packageJson.scripts['test:integration:raw'], /ISOLATED_DB_TEST/u);
  assert.match(packageJson.scripts['test:security:raw'], /ISOLATED_DB_TEST/u);
  assert.doesNotMatch(schema, /model (IdempotencyRecord|SyncConflict|OutboxMessage|NotificationAttempt)\b/u);
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), [
    '@nestjs/common', '@nestjs/core', '@nestjs/platform-express', '@nestjs/swagger', '@prisma/adapter-pg',
    '@prisma/client', 'class-transformer', 'class-validator', 'cookie-parser', 'helmet', 'luxon', 'pg',
    'reflect-metadata', 'rxjs',
  ]);
});

void test('every database release gate retains isolated Compose ownership and cleanup', async () => {
  const helper = await readFile('test/isolated-compose.sh', 'utf8');
  assert.match(helper, /PROJECT="\$\{PROJECT_PREFIX\}-\$\(date \+%s\)-\$\$"/u);
  assert.match(helper, /--env-file "\$ENV_FILE"/u);
  assert.match(helper, /name: \$\{PROJECT\}_postgres_data/u);
  assert.match(helper, /down -v --remove-orphans/u);
  assert.match(helper, /trap isolated_cleanup EXIT/u);
  assert.match(helper, /milktrack-backend/u);

  for (const file of ['integration-release.sh', 'security-release.sh', 'schedule-generation-volume.sh', 'migration-drift-contract.sh']) {
    const script = await readFile(`test/${file}`, 'utf8');
    assert.match(script, /\. "\$SCRIPT_DIR\/isolated-compose\.sh"/u, `${file} must source the shared helper`);
    assert.match(script, /PROJECT_PREFIX='milktrack-[^']+'/u, `${file} must use a unique project prefix`);
  }
  assert.match(await readFile('test/schedule-generation-volume.sh', 'utf8'), /P2_VOLUME_GATE/u);
});
