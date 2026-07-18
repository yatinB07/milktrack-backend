import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { ValidationTestController } from './fixtures/validation-test.controller.js';

@Module({ controllers: [ValidationTestController] })
class ValidationTestModule {}

void describe('configureApp validation', () => {
  let app: INestApplication;
  let baseUrl: string;

  before(async () => {
    const { configureApp } = await import('../src/bootstrap/configure-app.js');
    app = await NestFactory.create(ValidationTestModule, { logger: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');

    const address = (app.getHttpServer() as Server).address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => app?.close());

  void it('rejects an unknown request property', async () => {
    const response = await fetch(`${baseUrl}/v1/validation-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 1, unknown: true }),
    });

    assert.equal(response.status, 400);
  });

  void it('rejects an invalid typed value', async () => {
    const response = await fetch(`${baseUrl}/v1/validation-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 'not-a-number' }),
    });

    assert.equal(response.status, 400);
  });
});
