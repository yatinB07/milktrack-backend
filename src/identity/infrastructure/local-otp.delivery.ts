import { Injectable } from '@nestjs/common';

import { OtpDelivery } from '../application/otp-delivery.js';

type LocalOtpConfiguration = Readonly<{
  appEnv: string | undefined;
  provider: string | undefined;
}>;

@Injectable()
export class LocalOtpDelivery extends OtpDelivery {
  private readonly codes = new Map<string, string>();

  constructor(configuration: LocalOtpConfiguration) {
    super();
    if (
      (configuration.appEnv !== 'development' && configuration.appEnv !== 'test') ||
      configuration.provider !== 'local'
    ) {
      throw new Error('A real OTP provider is required in this environment');
    }
  }

  send(destination: string, code: string): Promise<void> {
    this.codes.set(destination, code);
    const masked = `${destination.slice(0, 3)}${'*'.repeat(Math.max(0, destination.length - 6))}${destination.slice(-3)}`;
    console.info(`MilkTrack development OTP for ${masked}: ${code}`);
    return Promise.resolve();
  }

  takeLastCodeForTest(normalizedPhone: string): string | undefined {
    const code = this.codes.get(normalizedPhone);
    this.codes.delete(normalizedPhone);
    return code;
  }
}
