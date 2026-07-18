import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it, test } from 'node:test';

import {
  Controller,
  Get,
  Inject,
  Module,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { configureApp } from '../src/bootstrap/configure-app.js';
import {
  type Actor,
  RequestContextStore,
  requestContextStore,
} from '../src/common/context/request-context.js';
import { CursorCodec } from '../src/common/cursor/cursor.js';
import { ApplicationError } from '../src/common/errors/application.error.js';

const inboundCorrelationId = '11111111-1111-4111-8111-111111111111';

@Controller('request-foundation-test')
class RequestFoundationTestController {
  constructor(
    @Inject(RequestContextStore)
    private readonly context: RequestContextStore,
  ) {}

  @Get('context')
  getContext(): { correlationId: string; hasActor: boolean } {
    const context = this.context.require();
    return { correlationId: context.correlationId, hasActor: Boolean(context.actor) };
  }

  @Get('application-error')
  throwApplicationError(): never {
    throw new ApplicationError('EXPECTED_ERROR', 'Expected message', 409, true, 3);
  }

  @Get('unknown-error')
  throwUnknownError(): never {
    throw new Error('sensitive internal detail');
  }
}

@Module({
  controllers: [RequestFoundationTestController],
  providers: [{ provide: RequestContextStore, useValue: requestContextStore }],
})
class RequestFoundationTestModule {}

void test('cursor round-trips timestamp/id and rejects tampering or limit > 100', () => {
  const codec = new CursorCodec();
  const value = {
    createdAt: new Date('2026-07-18T00:00:00.000Z'),
    id: inboundCorrelationId,
  };
  assert.deepEqual(codec.decode(codec.encode(value)), value);
  assert.throws(
    () => codec.parseLimit(101),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'INVALID_PAGINATION',
  );
  assert.throws(
    () => codec.decode('broken'),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'INVALID_CURSOR',
  );
});

void test('cursor rejects non-canonical encodings and tuple values', () => {
  const codec = new CursorCodec();
  const invalidPayloads: unknown[] = [
    ['2026-07-18T00:00:00.000Z', 1],
    [1, inboundCorrelationId],
    ['2026-07-18T00:00:00Z', inboundCorrelationId],
  ];

  for (const payload of invalidPayloads) {
    const cursor = Buffer.from(JSON.stringify(payload)).toString('base64url');
    assert.throws(
      () => codec.decode(cursor),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === 'INVALID_CURSOR',
    );
  }

  const validCursor = codec.encode({
    createdAt: new Date('2026-07-18T00:00:00.000Z'),
    id: inboundCorrelationId,
  });
  for (const cursor of [`${validCursor}=`, `${validCursor}!`]) {
    assert.throws(
      () => codec.decode(cursor),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === 'INVALID_CURSOR',
    );
  }
});

void test('production app creation registers and removes shutdown hooks', async () => {
  const before = process.listenerCount('SIGTERM');
  const { createApp } = await import('../src/bootstrap/create-app.js');
  const app = await createApp({ logger: false });

  try {
    assert.equal(process.listenerCount('SIGTERM'), before + 1);
  } finally {
    await app.close();
  }

  assert.equal(process.listenerCount('SIGTERM'), before);
});

void test('request context requires an authenticated actor', () => {
  const store = new RequestContextStore();
  assert.throws(
    () => store.run({ correlationId: inboundCorrelationId }, () => store.requireActor()),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'UNAUTHENTICATED',
  );

  const actor: Actor = {
    userId: inboundCorrelationId,
    sessionId: '22222222-2222-4222-8222-222222222222',
    displayName: 'Platform Administrator',
    authenticationMethod: 'administrator_mfa',
    platformRoles: ['platform_administrator'],
    memberships: [],
  };
  assert.equal(
    store.run({ correlationId: inboundCorrelationId, actor }, () => store.requireActor()),
    actor,
  );
});

void describe('request middleware and application error filter', () => {
  let app: INestApplication;
  let baseUrl: string;

  before(async () => {
    app = await NestFactory.create(RequestFoundationTestModule, { logger: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');

    const address = (app.getHttpServer() as Server).address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}/v1/request-foundation-test`;
  });

  after(() => app?.close());

  void it('accepts valid correlation IDs and never trusts actor or tenant headers', async () => {
    const response = await fetch(`${baseUrl}/context`, {
      headers: {
        'x-correlation-id': inboundCorrelationId,
        'x-actor-id': 'trusted-by-no-one',
        'x-vendor-id': '33333333-3333-4333-8333-333333333333',
      },
    });

    assert.equal(response.headers.get('x-correlation-id'), inboundCorrelationId);
    assert.deepEqual(await response.json(), {
      correlationId: inboundCorrelationId,
      hasActor: false,
    });
  });

  void it('replaces malformed correlation IDs', async () => {
    const response = await fetch(`${baseUrl}/context`, {
      headers: { 'x-correlation-id': 'broken' },
    });
    const correlationId = response.headers.get('x-correlation-id');

    assert.match(
      correlationId ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.notEqual(correlationId, 'broken');
  });

  void it('maps application errors with the request correlation ID', async () => {
    const response = await fetch(`${baseUrl}/application-error`, {
      headers: { 'x-correlation-id': inboundCorrelationId },
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      code: 'EXPECTED_ERROR',
      message: 'Expected message',
      retryable: true,
      correlationId: inboundCorrelationId,
      retryAfterSeconds: 3,
    });
  });

  void it('does not expose unknown error details', async () => {
    const response = await fetch(`${baseUrl}/unknown-error`, {
      headers: { 'x-correlation-id': inboundCorrelationId },
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 500);
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(body.correlationId, inboundCorrelationId);
    assert.doesNotMatch(JSON.stringify(body), /sensitive internal detail|stack/i);
  });
});
