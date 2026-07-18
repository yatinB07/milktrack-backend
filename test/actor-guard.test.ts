import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import type { ExecutionContext } from '@nestjs/common';

import { ActorGuard } from '../src/authorization/http/actor.guard.js';
import { RequestContextMiddleware } from '../src/common/context/request-context.middleware.js';
import {
  type Actor,
  RequestContextStore,
} from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import type { AuthenticationService } from '../src/identity/application/authentication.service.js';

const hmacKey = Buffer.from('0123456789abcdef0123456789abcdef');
const correlationId = '11111111-1111-4111-8111-111111111111';
const authenticatedActor: Actor = {
  userId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  displayName: 'Authenticated Administrator',
  authenticationMethod: 'administrator_mfa',
  platformRoles: ['platform_administrator'],
  memberships: [],
};
const untrustedActor: Actor = {
  userId: '44444444-4444-4444-8444-444444444444',
  sessionId: '55555555-5555-4555-8555-555555555555',
  displayName: 'Untrusted Header Identity',
  authenticationMethod: 'phone_otp',
  platformRoles: ['product_owner'],
  memberships: [],
};

function executionContext(
  authorization: string | readonly string[] | undefined,
  extraHeaders: Readonly<Record<string, string>> = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { authorization, ...extraHeaders },
      }),
    }),
  } as ExecutionContext;
}

function authenticationService(
  authenticate: (rawToken: string) => Promise<Actor>,
): AuthenticationService {
  return { authenticate } as AuthenticationService;
}

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

void test('replaceActor creates a new immutable context containing only the authenticated actor', () => {
  const store = new RequestContextStore();
  const original = {
    correlationId,
    ipHash: 'server-derived-ip-hash',
    deviceId: 'trusted-device',
    actor: untrustedActor,
  } as const;

  store.run(original, () => {
    store.replaceActor(authenticatedActor);

    assert.notEqual(store.require(), original);
    assert.deepEqual(store.require(), {
      correlationId,
      ipHash: 'server-derived-ip-hash',
      deviceId: 'trusted-device',
      actor: authenticatedActor,
    });
    assert.equal(original.actor, untrustedActor);
  });
});

void test('concurrent request flows retain distinct correlation IDs and actors across awaits', async () => {
  const store = new RequestContextStore();
  const firstEntered = deferred();
  const secondEntered = deferred();
  const firstCorrelationId = '77777777-7777-4777-8777-777777777777';
  const secondCorrelationId = '88888888-8888-4888-8888-888888888888';
  const secondActor: Actor = {
    ...authenticatedActor,
    userId: '99999999-9999-4999-8999-999999999999',
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayName: 'Second Administrator',
  };

  const first = store.run({ correlationId: firstCorrelationId }, async () => {
    store.replaceActor(authenticatedActor);
    assert.equal(store.require().correlationId, firstCorrelationId);
    assert.equal(store.requireActor(), authenticatedActor);
    firstEntered.resolve();
    await secondEntered.promise;
    assert.equal(store.require().correlationId, firstCorrelationId);
    assert.equal(store.requireActor(), authenticatedActor);
  });
  await firstEntered.promise;
  const second = store.run({ correlationId: secondCorrelationId }, async () => {
    store.replaceActor(secondActor);
    assert.equal(store.require().correlationId, secondCorrelationId);
    assert.equal(store.requireActor(), secondActor);
    secondEntered.resolve();
    await Promise.resolve();
    assert.equal(store.require().correlationId, secondCorrelationId);
    assert.equal(store.requireActor(), secondActor);
  });

  await Promise.all([first, second]);
});

void test('ActorGuard authenticates the raw opaque bearer token and replaces untrusted identity data', async () => {
  const tokens: string[] = [];
  const store = new RequestContextStore();
  const guard = new ActorGuard(
    authenticationService((token) => {
      tokens.push(token);
      return Promise.resolve(authenticatedActor);
    }),
    store,
  );

  await store.run(
    { correlationId, actor: untrustedActor },
    async () => {
      assert.equal(
        await guard.canActivate(
          executionContext('Bearer raw-opaque-token', {
            'x-actor-id': untrustedActor.userId,
            'x-role': 'product_owner',
            'x-vendor-id': '66666666-6666-4666-8666-666666666666',
          }),
        ),
        true,
      );
      assert.equal(store.requireActor(), authenticatedActor);
      assert.equal(store.requireActor().authenticationMethod, 'administrator_mfa');
    },
  );
  assert.deepEqual(tokens, ['raw-opaque-token']);
});

void test('ActorGuard returns the same stable 401 for missing, malformed, and revoked credentials', async () => {
  const store = new RequestContextStore();
  const acceptingGuard = new ActorGuard(
    authenticationService(() => Promise.resolve(authenticatedActor)),
    store,
  );
  const revokedGuard = new ActorGuard(
    authenticationService(() =>
      Promise.reject(
        new ApplicationError('AUTHENTICATION_FAILED', 'Authentication failed', 401),
      ),
    ),
    store,
  );
  const expectStableUnauthenticated = (error: unknown) =>
    error instanceof ApplicationError &&
    error.code === 'UNAUTHENTICATED' &&
    error.message === 'Authentication is required' &&
    error.status === 401;

  for (const authorization of [
    undefined,
    'Basic value',
    'Bearer',
    'Bearer ',
    'Bearer first second',
    ['Bearer token'],
  ] as const) {
    await assert.rejects(
      store.run({ correlationId }, () =>
        acceptingGuard.canActivate(executionContext(authorization)),
      ),
      expectStableUnauthenticated,
    );
  }
  await assert.rejects(
    store.run({ correlationId }, () =>
      revokedGuard.canActivate(executionContext('Bearer revoked-token')),
    ),
    expectStableUnauthenticated,
  );
});

void test('request middleware hashes only the socket address and ignores client IP headers', () => {
  const context = new RequestContextStore();
  const middleware = new RequestContextMiddleware(context, hmacKey);
  const capture = (
    remoteAddress: string,
    headers: Readonly<Record<string, string>>,
  ): string => {
    let ipHash: string | undefined;
    middleware.use(
      { headers, socket: { remoteAddress } },
      { setHeader: () => undefined },
      () => {
        ipHash = context.require().ipHash;
      },
    );
    assert.ok(ipHash);
    return ipHash;
  };

  const first = capture('127.0.0.1', {
    'x-forwarded-for': '203.0.113.1',
    'x-real-ip': '203.0.113.2',
    'cf-connecting-ip': '203.0.113.3',
  });
  const sameSocket = capture('127.0.0.1', {
    'x-forwarded-for': '198.51.100.1',
  });
  const anotherSocket = capture('127.0.0.2', {
    'x-forwarded-for': '203.0.113.1',
  });

  assert.equal(
    first,
    createHmac('sha256', hmacKey).update('127.0.0.1').digest('hex'),
  );
  assert.equal(sameSocket, first);
  assert.notEqual(anotherSocket, first);
  assert.doesNotMatch(JSON.stringify({ first, sameSocket, anotherSocket }), /127\.0\.0\./);
});
