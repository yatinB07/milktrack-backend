import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('phone OTP verification activates invitations before creating the session', async () => {
  const source = await readFile(
    new URL('../src/identity/infrastructure/prisma-identity.store.ts', import.meta.url),
    'utf8',
  );
  const verification = source.slice(
    source.indexOf('async verifyPhoneOtp'),
    source.indexOf('async startAdministratorSignIn'),
  );

  assert.match(verification, /userIdentity\.update/u);
  assert.match(verification, /activateInvitedPhoneMemberships/u);
  assert.ok(
    verification.indexOf('activateInvitedPhoneMemberships') < verification.indexOf('createSession'),
  );
});

void test('Identity infrastructure delegates tenant membership activation through its authority port', async () => {
  const source = await readFile(
    new URL('../src/identity/infrastructure/prisma-identity.store.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /vendorMembership/u);
  assert.match(source, /this\.authority\.activateInvitedPhoneMemberships/u);
  const authority = await readFile(
    new URL('../src/authorization/infrastructure/prisma-identity-authorization.adapter.ts', import.meta.url),
    'utf8',
  );
  assert.match(authority, /status: 'invited'/u);
  assert.match(authority, /endedAt: null/u);
  assert.match(authority, /deletedAt: null/u);
});

void test('membership ending accepts a current invited membership', async () => {
  const source = await readFile(
    new URL('../src/memberships/application/membership.service.ts', import.meta.url),
    'utf8',
  );
  const ending = source.slice(source.indexOf('  end('), source.indexOf('  async softDelete'));
  assert.match(ending, /this\.current\(tx, membershipId\)/u);
});
