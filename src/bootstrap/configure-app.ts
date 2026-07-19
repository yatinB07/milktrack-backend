import { isIP } from 'node:net';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { RequestContextMiddleware } from '../common/context/request-context.middleware.js';
import { requestContextStore } from '../common/context/request-context.js';
import { ApplicationErrorFilter } from '../common/errors/application-error.filter.js';

export function parseTrustedProxyCidrs(
  value: string | undefined,
): readonly string[] {
  if (!value?.trim()) return [];

  const cidrs = value.split(',').map((entry) => entry.trim());
  for (const cidr of cidrs) {
    const parts = cidr.split('/');
    const version = isIP(parts[0] ?? '');
    const prefix = parts[1];
    const maximumPrefix = version === 4 ? 32 : 128;
    if (
      parts.length > 2 ||
      version === 0 ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) ||
          Number(prefix) < 1 ||
          Number(prefix) > maximumPrefix))
    ) {
      throw new Error('TRUST_PROXY_CIDRS must contain only valid IP CIDRs');
    }
  }
  return cidrs;
}

export function configureApp(
  app: INestApplication,
  authHmacKey: Buffer,
  trustedProxyCidrs: readonly string[] = [],
): void {
  const expressApp = app.getHttpAdapter().getInstance() as {
    set(name: 'trust proxy', value: false | readonly string[]): void;
  };
  expressApp.set(
    'trust proxy',
    trustedProxyCidrs.length === 0 ? false : trustedProxyCidrs,
  );
  app.setGlobalPrefix('v1');
  app.use(helmet());
  app.use(cookieParser());
  const requestContextMiddleware = new RequestContextMiddleware(
    requestContextStore,
    authHmacKey,
  );
  app.use(requestContextMiddleware.use.bind(requestContextMiddleware));
  app.useGlobalFilters(new ApplicationErrorFilter(requestContextStore));
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const document = createOpenApiDocument(app);
  SwaggerModule.setup('openapi', app, document, {
    jsonDocumentUrl: 'openapi.json',
  });
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('MilkTrack API')
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' },
        'opaqueBearer',
      )
      .addCookieAuth(
        'milktrack_refresh',
        { type: 'apiKey', in: 'cookie' },
        'refreshCookie',
      )
      .build(),
  );
}
