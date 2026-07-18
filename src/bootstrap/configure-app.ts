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

export function configureApp(app: INestApplication, authHmacKey: Buffer): void {
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
