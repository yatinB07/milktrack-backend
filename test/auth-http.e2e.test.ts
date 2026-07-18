import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { ActorGuard } from '../src/identity/http/actor.guard.js';
import { configureApp } from '../src/bootstrap/configure-app.js';
import {
  type Actor,
  RequestContextStore,
  requestContextStore,
} from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import {
  AuthenticationService,
  type PendingMfaCredential,
  type PhoneOtpChallenge,
  type RequestPhoneOtpCommand,
  type SessionTokens,
  type StartAdministratorSignInCommand,
  type VerifyAdministratorMfaCommand,
  type VerifyPhoneOtpCommand,
} from '../src/identity/application/authentication.service.js';
import { AuthController } from '../src/identity/http/auth.controller.js';
import {
  AdminMfaRequestDto,
  AdminPasswordRequestDto,
  RefreshRequestDto,
  RequestOtpRequestDto,
  VerifyOtpRequestDto,
} from '../src/identity/http/auth.dto.js';

// tsx does not emit parameter metadata; the production Nest build does.
for (const [method, parameterTypes] of [
  ['requestOtp', [RequestOtpRequestDto]],
  ['verifyOtp', [VerifyOtpRequestDto, Object]],
  ['startAdministratorSignIn', [AdminPasswordRequestDto]],
  ['verifyAdministratorMfa', [AdminMfaRequestDto, Object]],
  ['refresh', [RefreshRequestDto, Object, Object]],
] as const) {
  Reflect.defineMetadata(
    'design:paramtypes',
    parameterTypes,
    AuthController.prototype,
    method,
  );
}

const authHmacKey = Buffer.from('0123456789abcdef0123456789abcdef');
const challengeToken = 'c'.repeat(43);
const pendingMfaToken = 'm'.repeat(43);
const accessToken = 'access-token';
const refreshToken = 'r'.repeat(43);
const rotatedAccessToken = 'rotated-access-token';
const rotatedRefreshToken = 's'.repeat(43);
const actor: Actor = {
  userId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  displayName: 'Vendor Administrator',
  authenticationMethod: 'administrator_mfa',
  platformRoles: ['platform_administrator'],
  memberships: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      vendorId: '44444444-4444-4444-8444-444444444444',
      vendorName: 'Milk Vendor',
      role: 'vendor_administrator',
      status: 'active',
    },
  ],
};

class FakeAuthenticationService extends AuthenticationService {
  readonly calls: Array<Readonly<{ operation: string; value: unknown }>> = [];

  requestPhoneOtp(command: RequestPhoneOtpCommand): Promise<PhoneOtpChallenge> {
    this.calls.push({ operation: 'requestPhoneOtp', value: command });
    if (command.phone === '+919999999429') {
      return Promise.reject(
        new ApplicationError('RATE_LIMITED', 'Try again later', 429, true, 23),
      );
    }
    return Promise.resolve({
      accepted: true,
      challengeToken,
      expiresAt: new Date('2026-07-18T12:05:00.000Z'),
    });
  }

  verifyPhoneOtp(command: VerifyPhoneOtpCommand): Promise<SessionTokens> {
    this.calls.push({ operation: 'verifyPhoneOtp', value: command });
    if (command.code === '000000') return Promise.reject(this.authenticationFailed());
    return Promise.resolve(this.tokens());
  }

  startAdministratorSignIn(
    command: StartAdministratorSignInCommand,
  ): Promise<PendingMfaCredential> {
    this.calls.push({ operation: 'startAdministratorSignIn', value: command });
    if (command.password === 'wrong') return Promise.reject(this.authenticationFailed());
    return Promise.resolve({
      pendingMfaToken,
      expiresAt: new Date('2026-07-18T12:05:00.000Z'),
    });
  }

  verifyAdministratorMfa(
    command: VerifyAdministratorMfaCommand,
  ): Promise<SessionTokens> {
    this.calls.push({ operation: 'verifyAdministratorMfa', value: command });
    if (command.code === '000000') return Promise.reject(this.authenticationFailed());
    return Promise.resolve(this.tokens());
  }

  refresh(token: string, deviceId: string): Promise<SessionTokens> {
    this.calls.push({ operation: 'refresh', value: { token, deviceId } });
    if (
      ![refreshToken, rotatedRefreshToken].includes(token) ||
      deviceId !== 'device-1'
    ) {
      return Promise.reject(this.authenticationFailed());
    }
    return Promise.resolve({
      accessToken: rotatedAccessToken,
      refreshToken: rotatedRefreshToken,
      accessExpiresAt: new Date('2026-07-18T12:15:00.000Z'),
      refreshExpiresAt: new Date('2026-08-18T12:00:00.000Z'),
    });
  }

  authenticate(token: string): Promise<Actor> {
    this.calls.push({ operation: 'authenticate', value: token });
    return token === accessToken
      ? Promise.resolve(actor)
      : Promise.reject(this.authenticationFailed());
  }

  logout(token: string): Promise<void> {
    this.calls.push({ operation: 'logout', value: token });
    return token === accessToken
      ? Promise.resolve()
      : Promise.reject(this.authenticationFailed());
  }

  logoutAll(token: string): Promise<void> {
    this.calls.push({ operation: 'logoutAll', value: token });
    return token === accessToken
      ? Promise.resolve()
      : Promise.reject(this.authenticationFailed());
  }

  private tokens(): SessionTokens {
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: new Date('2026-07-18T12:15:00.000Z'),
      refreshExpiresAt: new Date('2026-08-18T12:00:00.000Z'),
    };
  }

  private authenticationFailed(): ApplicationError {
    return new ApplicationError(
      'AUTHENTICATION_FAILED',
      'Authentication failed',
      401,
    );
  }
}

const authentication = new FakeAuthenticationService();

@Module({
  controllers: [AuthController],
  providers: [
    { provide: AuthenticationService, useValue: authentication },
    { provide: RequestContextStore, useValue: requestContextStore },
    {
      provide: ActorGuard,
      useFactory: () => new ActorGuard(authentication, requestContextStore),
    },
  ],
})
class AuthHttpTestModule {}

type Json = Readonly<Record<string, unknown>>;

void describe('authentication HTTP contract', () => {
  let app: INestApplication;
  let baseUrl: string;

  before(async () => {
    app = await NestFactory.create(AuthHttpTestModule, { logger: false });
    configureApp(app, authHmacKey);
    await app.listen(0, '127.0.0.1');
    const address = (app.getHttpServer() as Server).address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => app?.close());

  const post = (
    path: string,
    body: Json,
    headers: Readonly<Record<string, string>> = {},
  ) =>
    fetch(`${baseUrl}/v1/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  void it('rejects unknown and malformed request fields before application code', async () => {
    const cases: Array<Readonly<{ path: string; body: Json }>> = [
      {
        path: 'otp/request',
        body: { phone: '9876543210', purpose: 'sign_in' },
      },
      {
        path: 'otp/request',
        body: { phone: '+919876543210', purpose: 'sign_in', actorId: actor.userId },
      },
      {
        path: 'otp/verify',
        body: {
          challengeToken,
          code: '12345',
          deviceId: 'device-1',
          clientType: 'mobile',
        },
      },
      {
        path: 'otp/verify',
        body: {
          challengeToken,
          code: '123456',
          deviceId: 'bad device',
          clientType: 'mobile',
        },
      },
      {
        path: 'admin/password',
        body: { email: 'not-email', password: 'password', deviceId: 'device-1' },
      },
      {
        path: 'admin/mfa',
        body: {
          pendingMfaToken,
          code: 'abcdef',
          deviceId: 'device-1',
          clientType: 'browser',
        },
      },
    ];
    for (const entry of cases) {
      assert.equal(
        (await post(entry.path, entry.body)).status,
        400,
        `${entry.path}: ${JSON.stringify(entry.body)}`,
      );
    }
  });

  void it('returns indistinguishable OTP challenge shapes and forwards only server IP metadata', async () => {
    const responses = await Promise.all(
      ['+919876543210', '+919876500000'].map((phone) =>
        post(
          'otp/request',
          { phone, purpose: 'sign_in' },
          {
            'x-forwarded-for': '203.0.113.10',
            'x-actor-id': actor.userId,
            'x-role': 'platform_administrator',
          },
        ),
      ),
    );
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<Json>));

    assert.ok(responses.every((response) => response.status === 200));
    assert.deepEqual(Object.keys(bodies[0]).sort(), ['accepted', 'challengeToken', 'expiresAt']);
    assert.deepEqual(Object.keys(bodies[1]).sort(), ['accepted', 'challengeToken', 'expiresAt']);
    assert.equal(bodies[0].challengeToken, challengeToken);
    const calls = authentication.calls.filter(({ operation }) => operation === 'requestPhoneOtp');
    assert.equal(calls.length >= 2, true);
    for (const call of calls.slice(-2)) {
      const value = call.value as RequestPhoneOtpCommand;
      assert.match(value.ipHash ?? '', /^[0-9a-f]{64}$/);
      assert.notEqual(value.ipHash, '203.0.113.10');
    }
  });

  void it('maps browser and mobile session responses without duplicating refresh secrets', async () => {
    const browser = await post('otp/verify', {
      challengeToken,
      code: '123456',
      deviceId: 'device-1',
      deviceName: 'Browser',
      clientType: 'browser',
    });
    const browserBody = (await browser.json()) as Json;
    const browserCookie = browser.headers.get('set-cookie') ?? '';
    assert.equal(browser.status, 200);
    assert.deepEqual(Object.keys(browserBody).sort(), [
      'accessExpiresAt',
      'accessToken',
      'refreshExpiresAt',
    ]);
    assert.match(browserCookie, /^milktrack_refresh=/);
    assert.match(browserCookie, /HttpOnly/i);
    assert.match(browserCookie, /Secure/i);
    assert.match(browserCookie, /SameSite=Strict/i);
    assert.match(browserCookie, /Path=\/v1\/auth/i);

    const mobile = await post('admin/mfa', {
      pendingMfaToken,
      code: '123456',
      deviceId: 'device-1',
      clientType: 'mobile',
    });
    const mobileBody = (await mobile.json()) as Json;
    assert.equal(mobile.status, 200);
    assert.equal(mobileBody.refreshToken, refreshToken);
    assert.equal(mobile.headers.get('set-cookie'), null);
  });

  void it('supports device-bound browser-cookie and mobile-body refresh', async () => {
    const browser = await post(
      'refresh',
      { deviceId: 'device-1', clientType: 'browser' },
      { cookie: `milktrack_refresh=${refreshToken}` },
    );
    const browserBody = (await browser.json()) as Json;
    assert.equal(browser.status, 200);
    assert.equal(browserBody.refreshToken, undefined);
    assert.match(browser.headers.get('set-cookie') ?? '', /^milktrack_refresh=/);

    const mobile = await post('refresh', {
      refreshToken,
      deviceId: 'device-1',
      clientType: 'mobile',
    });
    assert.equal(mobile.status, 200);
    assert.equal(((await mobile.json()) as Json).refreshToken, rotatedRefreshToken);

    for (const [clientType, headers, body] of [
      ['browser', { cookie: `milktrack_refresh=${refreshToken}` }, {}],
      ['mobile', {}, { refreshToken }],
    ] as const) {
      const response = await post(
        'refresh',
        { ...body, deviceId: 'wrong-device', clientType },
        headers,
      );
      assert.equal(response.status, 401);
    }
  });

  void it('uses one stable authentication envelope and propagates Retry-After', async () => {
    const failures = await Promise.all([
      post('otp/verify', {
        challengeToken,
        code: '000000',
        deviceId: 'device-1',
        clientType: 'mobile',
      }),
      post('admin/password', {
        email: 'admin@example.test',
        password: 'wrong',
        deviceId: 'device-1',
      }),
    ]);
    const bodies = await Promise.all(failures.map((response) => response.json() as Promise<Json>));
    assert.ok(failures.every((response) => response.status === 401));
    assert.equal(bodies[0].code, 'AUTHENTICATION_FAILED');
    assert.equal(bodies[1].code, 'AUTHENTICATION_FAILED');
    assert.equal(bodies[0].message, bodies[1].message);

    const limited = await post('otp/request', {
      phone: '+919999999429',
      purpose: 'sign_in',
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '23');
    assert.equal(((await limited.json()) as Json).retryAfterSeconds, 23);
  });

  void it('protects actor and revocation endpoints and returns only the current-actor allowlist', async () => {
    for (const path of ['me', 'logout', 'logout-all']) {
      const method = path === 'me' ? 'GET' : 'POST';
      const absent = await fetch(`${baseUrl}/v1/auth/${path}`, { method });
      const revoked = await fetch(`${baseUrl}/v1/auth/${path}`, {
        method,
        headers: { authorization: 'Bearer revoked-token' },
      });
      assert.equal(absent.status, 401);
      assert.equal(revoked.status, 401);
      assert.equal(((await absent.json()) as Json).code, 'UNAUTHENTICATED');
      assert.equal(((await revoked.json()) as Json).code, 'UNAUTHENTICATED');
    }

    const me = await fetch(`${baseUrl}/v1/auth/me`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-actor-id': 'untrusted',
        'x-role': 'product_owner',
        'x-vendor-id': 'untrusted',
      },
    });
    const body = (await me.json()) as Json;
    assert.equal(me.status, 200);
    assert.deepEqual(Object.keys(body).sort(), [
      'displayName',
      'memberships',
      'platformRoles',
      'sessionId',
      'userId',
    ]);
    assert.doesNotMatch(
      JSON.stringify(body),
      /authenticationMethod|token|hash|secret|password/i,
    );

    for (const path of ['logout', 'logout-all']) {
      const response = await fetch(`${baseUrl}/v1/auth/${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          cookie: `milktrack_refresh=${refreshToken}`,
        },
      });
      assert.equal(response.status, 204);
      assert.match(response.headers.get('set-cookie') ?? '', /^milktrack_refresh=;/);
    }
  });

  void it('publishes explicit auth schemas, responses, errors, and security without persistence secrets', async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    const document = (await response.json()) as Json;
    const serialized = JSON.stringify(document);
    assert.equal(response.status, 200);
    for (const path of [
      '/v1/auth/otp/request',
      '/v1/auth/otp/verify',
      '/v1/auth/admin/password',
      '/v1/auth/admin/mfa',
      '/v1/auth/refresh',
      '/v1/auth/logout',
      '/v1/auth/logout-all',
      '/v1/auth/me',
    ]) {
      assert.ok((document.paths as Record<string, unknown>)[path]);
    }
    assert.match(serialized, /RequestOtpRequestDto|SessionResponseDto|CurrentActorResponseDto/);
    assert.match(serialized, /password/);
    assert.match(serialized, /code/);
    assert.match(serialized, /400/);
    assert.match(serialized, /401/);
    assert.match(serialized, /429/);
    assert.match(serialized, /opaqueBearer/);
    const refreshOperation = (
      document.paths as Record<
        string,
        { post?: { description?: string; security?: unknown } }
      >
    )['/v1/auth/refresh'].post;
    assert.deepEqual(refreshOperation?.security, [
      { refreshCookie: [] },
      {},
    ]);
    assert.match(
      refreshOperation?.description ?? '',
      /browser.*cookie.*mobile.*body/i,
    );
    assert.doesNotMatch(
      serialized,
      /passwordHash|encryptedSecret|tokenHash|codeHash|accessTokenHash|refreshTokenHash/,
    );
  });
});
