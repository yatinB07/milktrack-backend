import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module.js';
import { AgentStopOutcomeService, DefaultAgentStopOutcomeService } from '../src/delivery/application/agent-stop-outcome.service.js';
import { DefaultDeliveryCorrectionService, DeliveryCorrectionService } from '../src/delivery/application/delivery-correction.service.js';
import { AgentDeliveryController } from '../src/delivery/http/agent-delivery.controller.js';
import { CustomerDeliveryController } from '../src/delivery/http/customer-delivery.controller.js';
import { VendorDeliveryController } from '../src/delivery/http/vendor-delivery.controller.js';

const environment = {
  APP_ENV: 'test', OTP_PROVIDER: 'local', SESSION_TTL_SECONDS: '2592000',
  DATABASE_URL: 'postgresql://milktrack_app:milktrack_app_local@postgres:5432/milktrack',
  AUTH_HMAC_KEY: Buffer.alloc(32, 1).toString('base64'),
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
};

void test('application resolves both delivery workflows without a module cycle', async () => {
  const previous = new Map(Object.keys(environment).map((name) => [name, process.env[name]]));
  Object.assign(process.env, environment);
  try {
    const app = await NestFactory.createApplicationContext(AppModule, { abortOnError: false, logger: false });
    try {
      assert(app.get(DeliveryCorrectionService) instanceof DefaultDeliveryCorrectionService);
      assert(app.get(AgentStopOutcomeService) instanceof DefaultAgentStopOutcomeService);
      assert(app.get(VendorDeliveryController) instanceof VendorDeliveryController);
      assert(app.get(CustomerDeliveryController) instanceof CustomerDeliveryController);
      assert(app.get(AgentDeliveryController) instanceof AgentDeliveryController);
    } finally {
      await app.close();
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

void test('application wires delivery after leave and notifications without forwardRef', async () => {
  const source = await readFile(new URL('../src/app.module.ts', import.meta.url), 'utf8');
  assert.match(source, /LeaveModule,[\s\S]*NotificationsModule,[\s\S]*DeliveryModule,[\s\S]*SchedulingModule/u);
  assert.doesNotMatch(source, /forwardRef/u);
});
