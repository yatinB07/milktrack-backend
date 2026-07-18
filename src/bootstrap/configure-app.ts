import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { RequestContextMiddleware } from '../common/context/request-context.middleware.js';
import { requestContextStore } from '../common/context/request-context.js';
import { ApplicationErrorFilter } from '../common/errors/application-error.filter.js';

export function configureApp(app: INestApplication, authHmacKey: Buffer): void {
  app.setGlobalPrefix('v1');
  app.use(helmet());
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

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('MilkTrack API').setVersion('1.0').build(),
  );
  SwaggerModule.setup('openapi', app, document, {
    jsonDocumentUrl: 'openapi.json',
  });
}
