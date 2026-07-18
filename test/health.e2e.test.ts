import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import test from 'node:test';

void test('GET /v1/health publishes the health response contract', async (t) => {
  const { createApp } = await import('../src/bootstrap/create-app.js');
  const app = await createApp({ logger: false });

  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());

  const address = (app.getHttpServer() as Server).address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/v1/health`);
  assert.equal(response.status, 200);

  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['service', 'status', 'timestamp']);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'milktrack-backend');
  assert.ok(typeof body.timestamp === 'string');
  assert.equal(new Date(body.timestamp).toISOString(), body.timestamp);

  const openApiResponse = await fetch(`${baseUrl}/openapi.json`);
  assert.equal(openApiResponse.status, 200);
  const openApi = (await openApiResponse.json()) as {
    components?: { schemas?: Record<string, unknown> };
  };

  assert.deepEqual(openApi.components?.schemas?.HealthResponseDto, {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok'] },
      service: { type: 'string', enum: ['milktrack-backend'] },
      timestamp: { type: 'string', format: 'date-time' },
    },
    required: ['status', 'service', 'timestamp'],
  });
});
