import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const read = (path: string) => readFile(path, 'utf8');

const [
  readme,
  workflow,
  integration,
  security,
  volume,
  runtime,
  retained,
  migrationScript,
  helper,
] = await Promise.all([
  read('README.md'),
  read('.github/workflows/ci.yml'),
  read('test/integration-release.sh'),
  read('test/security-release.sh'),
  read('test/schedule-generation-volume.sh'),
  read('test/runtime-contract.sh'),
  read('test/retained-volume-contract.sh'),
  read('test/migration-drift-contract.sh'),
  read('test/isolated-compose.sh'),
]);

const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
  scripts: Record<string, string>;
};

function assertIsolationHelper(script: string) {
  assert.match(script, /PROJECT="\$\{PROJECT_PREFIX\}-\$\(date \+%s\)-\$\$"/);
  assert.match(script, /ENV_FILE=['"]\.env\.example['"]/);
  assert.match(script, /APP_URL=['"]postgresql:\/\/milktrack_app:milktrack_app_local@postgres:5432\/milktrack['"]/);
  assert.match(script, /OWNER_URL=['"]postgresql:\/\/milktrack_owner:milktrack_owner_local@postgres:5432\/milktrack['"]/);
  assert.match(script, /isolated_preflight/);
  assert.match(script, /reject_override/);
  assert.match(script, /echo "unsafe \$name override"/);
  assert.match(script, /rendered="\$\(isolated_compose config\)"/);
  assert.match(script, /grep -Fxq/);
  assert.match(script, /unsafe rendered Compose configuration/);
  assert.match(script, /DATABASE_URL="\$APP_URL"/);
  assert.match(script, /MIGRATION_DATABASE_URL="\$OWNER_URL"/);
  for (const name of [
    'POSTGRES_DB',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'MILKTRACK_APP_PASSWORD',
    'AUTH_HMAC_KEY',
    'MFA_ENCRYPTION_KEY',
    'SESSION_TTL_SECONDS',
    'APP_ENV',
    'OTP_PROVIDER',
    'TRUST_PROXY_CIDRS',
  ]) {
    assert.match(script, new RegExp(`${name}_VALUE=`));
    assert.match(script, new RegExp(`${name}="\\$${name}_VALUE"`));
  }
  assert.match(script, /POSTGRES_DB: \$POSTGRES_DB_VALUE/);
  assert.match(script, /POSTGRES_USER: \$POSTGRES_USER_VALUE/);
  assert.match(script, /POSTGRES_PASSWORD: \$POSTGRES_PASSWORD_VALUE/);
  assert.match(script, /MILKTRACK_APP_PASSWORD: \$MILKTRACK_APP_PASSWORD_VALUE/);
  assert.match(script, /APP_ENV: \$APP_ENV_VALUE/);
  assert.match(script, /trap isolated_cleanup EXIT/);
  assert.match(script, /trap 'exit 129' HUP/);
  assert.match(script, /trap 'exit 130' INT/);
  assert.match(script, /trap 'exit 143' TERM/);
  assert.match(script, /down -v --remove-orphans/);
  assert.match(script, /status=\$\?/);
  assert.match(script, /exit "\$status"/);
  assert.match(script, /docker compose --project-name "\$PROJECT" --env-file "\$ENV_FILE"/);
}

function assertIsolatedWrapper(script: string, prefix: string) {
  assert.match(script, new RegExp(`PROJECT_PREFIX=['"]${prefix}['"]`));
  assert.match(script, /\. "\$SCRIPT_DIR\/isolated-compose\.sh"/);
  const preflight = script.indexOf('isolated_preflight');
  const traps = script.indexOf('isolated_install_traps');
  const resource = script.search(/isolated_compose (build|up|run)/);
  assert.ok(preflight >= 0 && preflight < traps && traps < resource);
}

void test('documented and package integration entry points cannot target persistent development data', () => {
  assert.doesNotMatch(readme, /docker compose --env-file \.env down -v/);
  assert.doesNotMatch(readme, /docker compose[^\n]*integration[^\n]*test:integration/);
  assert.match(readme, /sh test\/integration-release\.sh/);
  assert.equal(packageJson.scripts['test:integration'], 'sh test/integration-release.sh');
  assert.match(packageJson.scripts['test:integration:raw'] ?? '', /ISOLATED_DB_TEST/);
  assert.match(packageJson.scripts['test:integration:raw'] ?? '', /TEST_OWNER_DATABASE_URL/);
  assert.match(packageJson.scripts['test:integration:raw'] ?? '', /node --import tsx --test/);
  assert.equal(packageJson.scripts['test:security'], 'sh test/security-release.sh');
  assert.match(packageJson.scripts['test:security:raw'] ?? '', /ISOLATED_DB_TEST/);
  assert.match(packageJson.scripts['test:security:raw'] ?? '', /TEST_OWNER_DATABASE_URL/);
});

void test('documented OpenAPI container commands never start database dependencies', () => {
  assert.match(readme, /docker compose --env-file \.env run --rm --no-deps \\\n\s+--volume/);
  assert.match(readme, /docker compose --env-file \.env run --rm --no-deps backend npm run openapi:check/);
});

void test('shared isolation helper scopes cleanup and preserves the gate status', async () => {
  assertIsolationHelper(helper);
  const directory = await mkdtemp(join(tmpdir(), 'milktrack-isolation-'));
  const docker = join(directory, 'docker');
  const cleanupLog = join(directory, 'cleanup.log');
  await writeFile(docker, `#!/bin/sh
project=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '--project-name' ]; then project="$argument"; fi
  previous="$argument"
done
case " $* " in
  *' config '*)
    printf '%s\n' \
      "name: $project" \
      "name: \${project}_postgres_data" \
      "POSTGRES_DB: $POSTGRES_DB" \
      "POSTGRES_USER: $POSTGRES_USER" \
      "POSTGRES_PASSWORD: $POSTGRES_PASSWORD" \
      "MILKTRACK_APP_PASSWORD: $MILKTRACK_APP_PASSWORD" \
      "DATABASE_URL: $DATABASE_URL" \
      "TEST_OWNER_DATABASE_URL: $MIGRATION_DATABASE_URL" \
      "AUTH_HMAC_KEY: $AUTH_HMAC_KEY" \
      "MFA_ENCRYPTION_KEY: $MFA_ENCRYPTION_KEY" \
      "APP_ENV: $APP_ENV" \
      "OTP_PROVIDER: $OTP_PROVIDER" \
      'TRUST_PROXY_CIDRS: ""'
    printf 'SESSION_TTL_SECONDS: "%s"\n' "$SESSION_TTL_SECONDS"
    if [ "\${OMIT_OWNER_DATABASE_URL:-}" != 1 ]; then
      printf '%s\n' "DATABASE_URL: $MIGRATION_DATABASE_URL"
    fi
    ;;
  *' down -v --remove-orphans '*) printf '%s\n' "$*" > "$ISOLATED_FAKE_LOG" ;;
  *) exit 1 ;;
esac
`);
  await chmod(docker, 0o755);
  try {
    const rejected = spawnSync(
      'sh',
      ['-c', "PROJECT_PREFIX='milktrack-contract'; . test/isolated-compose.sh; isolated_preflight"],
      {
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          ISOLATED_FAKE_LOG: cleanupLog,
          OMIT_OWNER_DATABASE_URL: '1',
        },
      },
    );
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr.toString(), /unsafe rendered Compose configuration/);

    const result = spawnSync(
      'sh',
      ['-c', "PROJECT_PREFIX='milktrack-contract'; SCRIPT_DIR='test'; . test/isolated-compose.sh; isolated_preflight; isolated_install_traps; exit 37"],
      { env: { PATH: `${directory}:${process.env.PATH}`, ISOLATED_FAKE_LOG: cleanupLog } },
    );
    assert.equal(result.status, 37, result.stderr.toString());
    const cleanup = await readFile(cleanupLog, 'utf8');
    assert.match(cleanup, /--project-name milktrack-contract-[0-9]+-[0-9]+/);
    assert.match(cleanup, /down -v --remove-orphans/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('raw database commands reject direct invocation before Node tests', () => {
  for (const command of ['test:integration:raw', 'test:security:raw']) {
    const result = spawnSync('npm', ['run', command], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Unsafe raw database test environment/);
  }
});

void test('integration release gate owns a disposable fail-closed Compose project', () => {
  assertIsolatedWrapper(integration, 'milktrack-integration');
  assert.match(integration, /--env ISOLATED_DB_TEST=1 \\\n\s+integration npm run test:integration:raw/);
});

void test('security release gate pins and validates its disposable database targets', () => {
  assertIsolatedWrapper(security, 'milktrack-security');
  assert.match(security, /--env ISOLATED_DB_TEST=1/);
  assert.match(security, /integration npm run test:security:raw/);
});

void test('schedule volume gate pins and validates its disposable database targets', () => {
  assertIsolatedWrapper(volume, 'milktrack-p2-volume');
});

void test('runtime contract provisions and removes its own isolated database', () => {
  assertIsolatedWrapper(runtime, 'milktrack-runtime');
  assert.match(runtime, /compose run --rm migrate/);
});

void test('retained-volume contract proves persistence only inside its disposable project', () => {
  assertIsolatedWrapper(retained, 'milktrack-retained');
  assert.match(retained, /compose restart postgres/);
  assert.match(retained, /compose down --remove-orphans/);
  assert.match(retained, /after_down/);
});

void test('migration drift gate validates every disposable database input before access', () => {
  assertIsolatedWrapper(migrationScript, 'milktrack-p2be05-drift');
  assert.match(migrationScript, /SHADOW_URL=/);
});

void test('CI invokes isolated wrappers and never calls the raw integration command', () => {
  assert.match(workflow, /name: Run integration tests\s+run: npm run test:integration/);
  assert.doesNotMatch(workflow, /compose[^\n]*integration[^\n]*test:integration/);
  assert.match(workflow, /run: bash test\/security-release\.sh/);
  assert.match(workflow, /run: bash test\/runtime-contract\.sh milktrack-backend:ci/);
  assert.match(workflow, /run: bash test\/retained-volume-contract\.sh/);
  assert.doesNotMatch(workflow, /run: docker compose[^\n]*down -v/);
});
