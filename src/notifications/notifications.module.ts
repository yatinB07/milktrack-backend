import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DefaultNotificationService, NotificationService } from './application/notification.service.js';
import { NotificationWriter } from './application/notification-writer.js';
import { CustomerNotificationController } from './http/customer-notification.controller.js';
import { PrismaNotificationStore } from './infrastructure/prisma-notification.store.js';

@Module({
  imports: [AuthorizationModule, CustomersModule, DatabaseModule],
  controllers: [CustomerNotificationController],
  providers: [PrismaNotificationStore, { provide: NotificationWriter, useExisting: PrismaNotificationStore }, DefaultNotificationService, { provide: NotificationService, useExisting: DefaultNotificationService }],
  exports: [NotificationWriter],
})
export class NotificationsModule {}
