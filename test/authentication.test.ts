import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it, test } from 'node:test';

import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { configureApp } from '../src/bootstrap/configure-app.js';
import {
  RequestContextStore,
  requestContextStore,
} from '../src/common/context/request-context.js';
import { ApplicationError } from '../src/common/errors/application.error.js';
import { IdentityModule } from '../src/identity/identity.module.js';
import {
  normalizeEmail,
  normalizePhone,
} from '../src/identity/domain/identity-normalization.js';
import { LocalOtpDelivery } from '../src/identity/infrastructure/local-otp.delivery.js';

const authHmacKey = Buffer.from('0123456789abcdef0123456789abcdef');

void test('local OTP delivery is restricted to explicit local development and test environments', async () => {
  for (const appEnv of ['development', 'test'] as const) {
    const delivery = new LocalOtpDelivery({ appEnv, provider: 'local' });
    const messages: unknown[][] = [];
    const originalInfo = console.info;
    console.info = (...values: unknown[]) => messages.push(values);
    try {
      await delivery.send('+919876543210', '123456');
    } finally {
      console.info = originalInfo;
    }

    assert.equal(delivery.takeLastCodeForTest('+919876543210'), '123456');
    assert.deepEqual(messages, [
      ['MilkTrack development OTP for +91*******210: 123456'],
    ]);
  }

  for (const configuration of [
    { appEnv: 'staging', provider: 'local' },
    { appEnv: 'production', provider: 'local' },
    { appEnv: 'development', provider: undefined },
    { appEnv: 'development', provider: 'smtp' },
    { appEnv: undefined, provider: 'local' },
  ]) {
    assert.throws(
      () => new LocalOtpDelivery(configuration),
      /real OTP provider is required/i,
    );
  }
});

void test('identity normalization returns canonical email and E.164 phone values', () => {
  assert.equal(normalizeEmail(' ADMIN@Example.TEST '), 'admin@example.test');
  assert.equal(normalizePhone(' +919876543210 '), '+919876543210');
  for (const value of ['missing-at.example.test', 'a @example.test']) {
    assert.throws(
      () => normalizeEmail(value),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === 'INVALID_EMAIL',
    );
  }
  for (const value of ['9876543210', '+0123456789', '+123']) {
    assert.throws(
      () => normalizePhone(value),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === 'INVALID_PHONE',
    );
  }
});

void test('IdentityModule rejects a local provider outside local environments', async () => {
  const previous = {
    APP_ENV: process.env.APP_ENV,
    OTP_PROVIDER: process.env.OTP_PROVIDER,
  };
  process.env.APP_ENV = 'production';
  process.env.OTP_PROVIDER = 'local';
  try {
    await assert.rejects(
      NestFactory.createApplicationContext(IdentityModule, {
        logger: false,
        abortOnError: false,
      }),
      /real OTP provider is required/i,
    );
  } finally {
    if (previous.APP_ENV === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previous.APP_ENV;
    if (previous.OTP_PROVIDER === undefined) delete process.env.OTP_PROVIDER;
    else process.env.OTP_PROVIDER = previous.OTP_PROVIDER;
  }
});

@Controller('authentication-test')
class AuthenticationTestController {
  @Get('rate-limit')
  rateLimit(): never {
    throw new ApplicationError(
      'RATE_LIMITED',
      'Try again later',
      429,
      true,
      17,
    );
  }
}

@Module({
  controllers: [AuthenticationTestController],
  providers: [{ provide: RequestContextStore, useValue: requestContextStore }],
})
class AuthenticationTestModule {}

void describe('authentication rate-limit HTTP contract', () => {
  let app: INestApplication;
  let baseUrl: string;

  before(async () => {
    app = await NestFactory.create(AuthenticationTestModule, { logger: false });
    configureApp(app, authHmacKey);
    await app.listen(0, '127.0.0.1');
    const address = (app.getHttpServer() as Server).address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}/v1/authentication-test`;
  });

  after(() => app?.close());

  void it('returns matching positive retry metadata and Retry-After header', async () => {
    const response = await fetch(`${baseUrl}/rate-limit`);
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '17');
    assert.equal(body.code, 'RATE_LIMITED');
    assert.equal(body.retryable, true);
    assert.equal(body.retryAfterSeconds, 17);
  });
});
