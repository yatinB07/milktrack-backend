import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? typescriptFiles(entryPath)
        : Promise.resolve(entry.name.endsWith('.ts') ? [entryPath] : []);
    }),
  );
  return nested.flat();
}

void test('Prisma stays inside infrastructure and generated source', async () => {
  const files = await typescriptFiles('src');
  const violations: string[] = [];

  for (const file of files) {
    const normalized = file.split(path.sep).join('/');
    if (
      normalized.includes('/infrastructure/') ||
      normalized.includes('/generated/') ||
      normalized.includes('/bootstrap/')
    ) {
      continue;
    }
    const source = await readFile(file, 'utf8');
    if (
      /from ['"][^'"]*(?:generated\/prisma|@prisma\/|prisma-transaction-context)[^'"]*['"]/.test(
        source,
      )
    ) {
      violations.push(normalized);
    }
  }

  assert.deepEqual(violations, []);
});

void test('identity infrastructure does not query authorization, vendor, or membership tables', async () => {
  const files = await typescriptFiles('src/identity/infrastructure');
  const forbidden = [
    /\.platformRoleAssignment\b/,
    /\.supportAccessGrant\b/,
    /\.vendorMembership\b/,
    /\.vendor\.(?:find|count|update|create|delete)/,
    /\bplatform_role_assignments\b/i,
    /\bsupport_access_grants\b/i,
    /\bvendor_memberships\b/i,
    /\bFROM\s+vendors\b/i,
  ];
  const violations: string[] = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (forbidden.some((pattern) => pattern.test(source))) {
      violations.push(file.split(path.sep).join('/'));
    }
  }

  assert.deepEqual(violations, []);
});

void test('authorization source does not import Identity', async () => {
  const files = await typescriptFiles('src/authorization');
  const violations: string[] = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/from ['"][^'"]*identity\//.test(source)) {
      violations.push(file.split(path.sep).join('/'));
    }
  }

  assert.deepEqual(violations, []);
});
