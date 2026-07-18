import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

void test('CI runs Phase 1 release gates in order without a host database URL', () => {
  const orderedSteps = [
    'Install dependencies',
    'Verify application',
    'Validate Prisma schema',
    'Start empty PostgreSQL',
    'Deploy migrations',
    'Run integration tests',
    'Run security release gate',
    'Check OpenAPI drift',
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
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /docker compose[^\n]* down -v --remove-orphans/);
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

void test('runtime and retained-volume scripts exercise real production and persistence paths', async () => {
  const runtime = await readFile('test/runtime-contract.sh', 'utf8');
  const retained = await readFile('test/retained-volume-contract.sh', 'utf8').catch(
    () => '',
  );

  assert.match(runtime, /docker run --detach/);
  assert.match(runtime, /fetch\('http:\/\/127\.0\.0\.1:3000\/v1\/health'\)/);
  assert.doesNotMatch(runtime, /TEST_OWNER_DATABASE_URL=/);
  assert.doesNotMatch(runtime, /MIGRATION_DATABASE_URL=/);
  assert.match(retained, /docker compose restart postgres/);
  assert.match(retained, /docker compose down --remove-orphans/);
  assert.match(retained, /_prisma_migrations/);
});
