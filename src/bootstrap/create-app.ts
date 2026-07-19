import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import { validateAuthenticationEnvironment } from './auth-environment.js';
import { configureApp, parseTrustedProxyCidrs } from './configure-app.js';

export async function createApp(
  options: { logger?: false } = {},
): Promise<INestApplication> {
  const authenticationEnvironment = validateAuthenticationEnvironment(process.env);
  const trustedProxyCidrs = parseTrustedProxyCidrs(
    process.env.TRUST_PROXY_CIDRS,
  );
  const app = await NestFactory.create(AppModule, options);
  configureApp(app, authenticationEnvironment.authHmacKey, trustedProxyCidrs);
  app.enableShutdownHooks();
  return app;
}
