import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const files = {
  web: 'openapi/supported-clients/web-phase1.json',
  mobile: 'openapi/supported-clients/mobile-phase1.json',
  provenance: 'openapi/supported-clients/provenance.json',
  compatibility: 'test/openapi-supported-client-compatibility.sh',
  drift: 'test/migration-drift-contract.sh',
} as const;

const hashes = {
  web: 'f8042b34f7b3bfee66e64262c5aa63e5b4f5022876b975bbf272d410bd3c37ce',
  mobile: '97b29edd4b21ce88c7fb1d33d6ca0f24d9040323f5b1b3366d3878c4e8d6faa1',
} as const;

const oasdiff =
  'tufin/oasdiff:v1.23.0@sha256:47c5709a744083d278df45cf24643b6fe30d98bde2a40a929cb512fbca6a0cc0';

async function sha256(path: string) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

void test('Phase 2 release gate artifacts and executable scripts exist', async () => {
  await Promise.all(Object.values(files).map((path) => access(path)));
  for (const path of [files.compatibility, files.drift]) {
    assert.notEqual((await stat(path)).mode & 0o111, 0, `${path} must be executable`);
  }
});

void test('supported-client baselines have verified immutable provenance', async () => {
  assert.equal(await sha256(files.web), hashes.web);
  assert.equal(await sha256(files.mobile), hashes.mobile);

  const provenance = JSON.parse(await readFile(files.provenance, 'utf8')) as {
    schemaVersion: number;
    oasdiffImage: string;
    baselines: Record<string, unknown>;
  };
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.oasdiffImage, oasdiff);
  assert.deepEqual(provenance.baselines, {
    web: {
      file: 'web-phase1.json',
      sha256: hashes.web,
      consumerRepository: 'milktrack-web',
      consumerPath: 'openapi/milktrack-backend-v1.json',
      consumerCommit: 'eb0ba4db3b3f3aff841de5983bdce60235b46f79',
      backendSourceCommit: '5ade987a2f42337655eb5018275933679ccb3b27',
    },
    mobile: {
      file: 'mobile-phase1.json',
      sha256: hashes.mobile,
      consumers: [
        {
          repository: 'milktrack-customer-app',
          path: 'openapi/openapi.json',
          commit: '7bf98f70a6db2387cad642afb971708f78e2f518',
        },
        {
          repository: 'milktrack-agent-app',
          path: 'openapi/openapi.json',
          commit: '87e035347f5738a720cbd6875f280a52300437a9',
        },
      ],
      backendSourceCommit: '3d433b2631c2bcc3391b6a3730cf8884623d4870',
    },
  });
});

void test('OpenAPI compatibility gate uses the pinned semantic checker for both baselines', async () => {
  const script = await readFile(files.compatibility, 'utf8');
  assert.match(script, new RegExp(oasdiff.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(script, /:latest|tufin\/oasdiff\s/);
  assert.match(script, /docker run --rm --network none/);
  assert.match(script, /breaking --fail-on ERR \/specs\/supported-clients\/web-phase1\.json \/specs\/v1\.json/);
  assert.match(script, /breaking --fail-on ERR \/specs\/supported-clients\/mobile-phase1\.json \/specs\/v1\.json/);
  assert.match(script, /sha256sum --check/);
});

void test('migration drift gate is isolated and proves both clean and detected states', async () => {
  const script = await readFile(files.drift, 'utf8');
  assert.match(script, /PROJECT="milktrack-p2be05-drift-\$\(date \+%s\)-\$\$"/);
  assert.match(script, /\[ "\$PROJECT" = "milktrack-backend" \]/);
  assert.match(script, /--env-file "\$ENV_FILE"/);
  assert.match(script, /down -v --remove-orphans/);
  assert.match(script, /npx prisma migrate status/);
  assert.match(script, /--from-migrations "\$MIGRATIONS"/);
  assert.match(script, /--to-config-datasource/);
  assert.match(script, /shadowDatabaseUrl: env\('SHADOW_DATABASE_URL'\)/);
  assert.match(script, /provider = "postgresql"/);
  assert.match(script, /CREATE DATABASE milktrack_shadow/);
  assert.match(script, /ALTER TABLE vendors ADD COLUMN p2_drift_probe TEXT/);
  assert.match(script, /\[ "\$drift_status" -ne 2 \]/);
  assert.match(script, /ALTER TABLE vendors DROP COLUMN p2_drift_probe/);
});
