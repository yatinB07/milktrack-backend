import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module.js';
import { validateAuthenticationEnvironment } from './auth-environment.js';
import { configureApp } from './configure-app.js';

export async function createApp(
  options: { logger?: false } = {},
): Promise<INestApplication> {
  const authenticationEnvironment = validateAuthenticationEnvironment(process.env);
  const app = await NestFactory.create(AppModule, options);
  configureApp(app, authenticationEnvironment.authHmacKey);
  app.enableShutdownHooks();
  return app;
}
