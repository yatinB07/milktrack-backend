import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { SubscriptionLabelReader } from './application/subscription-label.reader.js';
import { PrismaSubscriptionLabelReader } from './infrastructure/prisma-subscription-label.reader.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    PrismaSubscriptionLabelReader,
    { provide: SubscriptionLabelReader, useExisting: PrismaSubscriptionLabelReader },
  ],
  exports: [SubscriptionLabelReader],
})
export class SubscriptionLabelsModule {}
