import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateAuthenticationEnvironment } from '../src/bootstrap/auth-environment.js';
import { OtpCodes } from '../src/identity/domain/otp.js';
import { PasswordHasher } from '../src/identity/domain/password.js';
import { SecretBox } from '../src/identity/domain/secret-box.js';
import { TokenSecrets } from '../src/identity/domain/token-hash.js';
import { Totp } from '../src/identity/domain/totp.js';

const AUTH_KEY = Buffer.from('0123456789abcdef0123456789abcdef');
const MFA_KEY = Buffer.from('fedcba9876543210fedcba9876543210');

function totpCode(secret: Buffer, timeMs: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest.at(-1)! & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000;
  return value.toString().padStart(6, '0');
}

void test('password hashes round-trip and reject a wrong password', async () => {
  const hasher = new PasswordHasher();
  const encoded = await hasher.hash('correct horse battery staple');

  assert.equal(await hasher.verify('correct horse battery staple', encoded), true);
  assert.equal(await hasher.verify('wrong password', encoded), false);
  assert.deepEqual(encoded.parameters, {
    N: 16_384,
    r: 8,
    p: 1,
    keyLength: 64,
  });
  assert.equal(Buffer.from(encoded.salt, 'base64').length, 16);
  assert.equal(Buffer.from(encoded.hash, 'base64').length, 64);
});

void test('password hashes use distinct random salts', async () => {
  const hasher = new PasswordHasher();
  const first = await hasher.hash('same password');
  const second = await hasher.hash('same password');

  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
});

void test('OTP codes are six digits and HMAC verification rejects the wrong code', () => {
  const codes = new OtpCodes(AUTH_KEY);
  const code = codes.generate();
  const digest = codes.hash(code);

  assert.match(code, /^\d{6}$/);
  assert.equal(codes.verify(code, digest), true);
  assert.equal(codes.verify(code === '000000' ? '000001' : '000000', digest), false);
  assert.deepEqual(OtpCodes.policy, {
    lifetimeSeconds: 300,
    maximumAttempts: 5,
    resendWindowSeconds: 60,
    maximumRequestsPerWindow: 5,
    requestWindowSeconds: 900,
  });
});

void test('TOTP accepts the current 30-second step and rejects a code outside ±1 step', () => {
  const secret = Buffer.from('12345678901234567890');
  const secretBase32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const now = 1_700_000_000_000;
  const totp = new Totp();

  assert.equal(totp.verify(secretBase32, totpCode(secret, now), now), true);
  assert.equal(totp.verify(secretBase32, totpCode(secret, now + 60_000), now), false);
});

void test('TOTP secret validation accepts canonical base32 and rejects malformed input', () => {
  const totp = new Totp();

  assert.doesNotThrow(() => totp.validateSecret('JBSWY3DPEHPK3PXP'));
  assert.throws(() => totp.validateSecret('not-base32!'), /RFC 4648 base32/);
});

void test('AES-GCM round-trips plaintext and rejects tampering', () => {
  const box = new SecretBox(MFA_KEY);
  const encrypted = box.encrypt('base32 MFA secret');
  const segments = encrypted.split('.');

  assert.equal(segments.length, 3);
  assert.equal(Buffer.from(segments[0], 'base64url').length, 12);
  assert.equal(box.decrypt(encrypted), 'base32 MFA secret');

  const ciphertext = Buffer.from(segments[2], 'base64url');
  ciphertext[0] ^= 1;
  assert.throws(() =>
    box.decrypt(`${segments[0]}.${segments[1]}.${ciphertext.toString('base64url')}`),
  );
});

void test('session tokens contain 32 random bytes and expose only a persistable HMAC hash', () => {
  const tokens = new TokenSecrets(AUTH_KEY);
  const token = tokens.issue();
  const second = tokens.issue();
  const digest = tokens.hash(token);

  assert.ok(Buffer.from(token, 'base64url').length >= 32);
  assert.notEqual(token, second);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest.includes(token), false);
});

void test('committed local authentication keys decode to exactly 32 bytes', async () => {
  const envFile = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  const values = Object.fromEntries(
    envFile
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );

  assert.equal(Buffer.from(values.AUTH_HMAC_KEY, 'base64').length, 32);
  assert.equal(Buffer.from(values.MFA_ENCRYPTION_KEY, 'base64').length, 32);
  assert.equal(values.TRUST_PROXY_CIDRS, '');
});

void test('authentication environment rejects missing, malformed, non-canonical, and wrong-length keys', () => {
  const valid = {
    AUTH_HMAC_KEY: AUTH_KEY.toString('base64'),
    MFA_ENCRYPTION_KEY: MFA_KEY.toString('base64'),
  };

  for (const name of ['AUTH_HMAC_KEY', 'MFA_ENCRYPTION_KEY'] as const) {
    assert.throws(() => validateAuthenticationEnvironment({ ...valid, [name]: undefined }));
    assert.throws(() => validateAuthenticationEnvironment({ ...valid, [name]: '!!!!' }));
    assert.throws(() =>
      validateAuthenticationEnvironment({
        ...valid,
        [name]: Buffer.alloc(31).toString('base64'),
      }),
    );
    assert.throws(() =>
      validateAuthenticationEnvironment({
        ...valid,
        [name]: Buffer.alloc(33).toString('base64'),
      }),
    );
    assert.throws(() =>
      validateAuthenticationEnvironment({
        ...valid,
        [name]: valid[name].replace(/=$/, ''),
      }),
    );
  }
});

void test('production application bootstrap validates authentication keys before creating Nest', async () => {
  const previous = process.env.AUTH_HMAC_KEY;
  delete process.env.AUTH_HMAC_KEY;
  try {
    const { createApp } = await import('../src/bootstrap/create-app.js');
    await assert.rejects(createApp({ logger: false }), /AUTH_HMAC_KEY/);
  } finally {
    if (previous === undefined) delete process.env.AUTH_HMAC_KEY;
    else process.env.AUTH_HMAC_KEY = previous;
  }
});

void test('Compose passes authentication configuration to backend and integration only', async () => {
  const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const backend = compose.match(/ {2}backend:\n([\s\S]*?)\n {2}integration:/)?.[1] ?? '';
  const integration = compose.match(/ {2}integration:\n([\s\S]*?)\nvolumes:/)?.[1] ?? '';
  const postgres = compose.match(/ {2}postgres:\n([\s\S]*?)\n {2}migrate:/)?.[1] ?? '';
  const migrate = compose.match(/ {2}migrate:\n([\s\S]*?)\n {2}backend:/)?.[1] ?? '';

  for (const service of [backend, integration]) {
    assert.match(service, /AUTH_HMAC_KEY:/);
    assert.match(service, /MFA_ENCRYPTION_KEY:/);
    assert.match(service, /SESSION_TTL_SECONDS:/);
    assert.match(service, /APP_ENV:/);
    assert.match(service, /OTP_PROVIDER:/);
  }
  assert.match(backend, /TRUST_PROXY_CIDRS:/);
  for (const service of [postgres, migrate, integration]) {
    assert.doesNotMatch(service, /TRUST_PROXY_CIDRS:/);
  }
  assert.doesNotMatch(dockerfile, /AUTH_HMAC_KEY|MFA_ENCRYPTION_KEY/);
});
