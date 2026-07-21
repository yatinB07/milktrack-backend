import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
const compose = await readFile('compose.yaml', 'utf8');
const dockerfile = await readFile('Dockerfile', 'utf8');
const gitignore = await readFile('.gitignore', 'utf8');
const readme = await readFile('README.md', 'utf8');
const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};

void test('CI runs Phase 1 release gates in order without a host database URL', () => {
  const orderedSteps = [
    'Install dependencies',
    'Verify application',
    'Validate Prisma schema',
    'Check migration drift',
    'Run integration tests',
    'Run security release gate',
    'Check OpenAPI drift',
    'Check supported-client compatibility',
    'Validate Compose contract',
    'Build production image',
    'Audit production dependencies',
    'Check production runtime contract',
    'Check retained database volume',
  ];

  let previous = -1;
  for (const step of orderedSteps) {
    const current = workflow.indexOf(`name: ${step}`);
    assert.ok(current > previous, `${step} must follow the previous release gate`);
    previous = current;
  }

  assert.doesNotMatch(workflow, /127\.0\.0\.1:5432/);
  assert.match(workflow, /timeout-minutes: 25/);
  assert.doesNotMatch(workflow, /docker compose[^\n]* down -v --remove-orphans/);
});

void test('CI enforces migration and supported-client compatibility without the manual volume gate', () => {
  assert.equal(
    packageJson.scripts['test:migration-drift'],
    'sh test/migration-drift-contract.sh',
  );
  assert.equal(
    packageJson.scripts['test:openapi-compatibility'],
    'sh test/openapi-supported-client-compatibility.sh',
  );
  assert.equal(
    packageJson.scripts['test:schedule-volume'],
    'sh test/schedule-generation-volume.sh',
  );
  assert.match(workflow, /name: Check migration drift\s+run: npm run test:migration-drift/);
  assert.match(
    workflow,
    /name: Check supported-client compatibility\s+run: npm run test:openapi-compatibility/,
  );
  assert.doesNotMatch(workflow, /test:schedule-volume|schedule-generation-volume/);
});

void test('verification generates the ignored Prisma client before linting', () => {
  assert.match(gitignore, /^src\/generated\/prisma\/$/m);
  assert.equal(
    packageJson.scripts.verify,
    'npm run db:generate && npm run lint && npm run typecheck && npm test && npm run build',
  );
});

void test('tagged CI publishes the versioned OpenAPI artifact after verification', () => {
  assert.match(workflow, /tags:\s*\[['"]v\*['"]\]/);
  assert.match(workflow, /publish-openapi:/);
  assert.match(workflow, /needs: verify/);
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /publish-openapi:[\s\S]*?permissions:\s*\n\s*contents: write/);
  assert.match(workflow, /gh release view/);
  assert.match(workflow, /gh release upload[^\n]*--clobber/);
  assert.match(workflow, /gh release create[^\n]*--verify-tag/);
  assert.match(workflow, /openapi\/v1\.json/);
});

void test('runtime inputs and database role are fixed and reproducible', () => {
  assert.match(
    dockerfile,
    /^FROM node:24\.18\.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base/m,
  );
  assert.match(
    compose,
    /image: postgres:18\.4@sha256:32ca0af8e77bfb8c6610c488e4691f83f972a3e9e64d3b02facf3ab111ad5500/,
  );
  assert.doesNotMatch(compose, /MILKTRACK_APP_USER/);
  assert.match(workflow, /node-version: 24\.18\.0/);
  assert.doesNotMatch(workflow, /node-version: 24\s*$/m);
  assert.equal(packageJson.dependencies['@types/cookie-parser'], undefined);
  assert.equal(packageJson.devDependencies['@types/cookie-parser'], '1.4.10');
});

void test('documented runtime contract uses the isolated Compose project', () => {
  assert.match(
    readme,
    /sh test\/runtime-contract\.sh milktrack-backend:production/,
  );
  assert.doesNotMatch(readme, /COMPOSE_PROJECT_NAME=milktrack-production-contract/);
});

void test('runtime and retained-volume scripts exercise real production and persistence paths', async () => {
  const runtime = await readFile('test/runtime-contract.sh', 'utf8');
  const retained = await readFile('test/retained-volume-contract.sh', 'utf8').catch(
    () => '',
  );

  assert.match(runtime, /docker run --detach/);
  assert.match(runtime, /fetch\('http:\/\/127\.0\.0\.1:3000\/v1\/health'\)/);
  assert.match(runtime, /node dist\/worker\.js/);
  assert.match(runtime, /\{\{\.Image\}\}/);
  assert.match(runtime, /docker port "\$worker_container"/);
  assert.match(runtime, /docker stop --time 10 "\$worker_container"/);
  assert.match(runtime, /\{\{\.State\.ExitCode\}\}/);
  assert.doesNotMatch(runtime, /--env (TEST_OWNER_DATABASE_URL|MIGRATION_DATABASE_URL)=/);
  assert.match(retained, /PROJECT_PREFIX='milktrack-retained'/);
  assert.match(retained, /\. "\$SCRIPT_DIR\/isolated-compose\.sh"/);
  assert.match(retained, /compose restart postgres/);
  assert.match(retained, /compose down --remove-orphans/);
  assert.match(retained, /compose build migrate/);
  assert.match(retained, /compose run --rm migrate/);
  assert.match(retained, /find prisma\/migrations/);
  assert.match(retained, /if \[ "\$before" != "\$expected" \]/);
  assert.match(
    retained,
    /if \[ "\$expected" != "\$after_restart" \] \|\| \[ "\$expected" != "\$after_down" \]/,
  );
  assert.match(retained, /_prisma_migrations/);

  const build = retained.indexOf('compose build migrate');
  const deploy = retained.indexOf('compose run --rm migrate');
  const count = retained.indexOf('before="$(migration_count)"');
  assert.ok(build >= 0 && build < deploy && deploy < count);
});
