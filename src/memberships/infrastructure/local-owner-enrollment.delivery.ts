import { Injectable } from '@nestjs/common';

import { OwnerEnrollmentDelivery } from '../application/owner-enrollment.delivery.js';

@Injectable()
export class LocalOwnerEnrollmentDelivery extends OwnerEnrollmentDelivery {
  private readonly tokens = new Map<string, string>();

  constructor(appEnv: string | undefined, provider: string | undefined) {
    super();
    if (
      (appEnv !== 'development' && appEnv !== 'test') ||
      provider !== 'local'
    ) {
      throw new Error('A real owner enrollment delivery provider is required');
    }
  }

  send(destination: string, setupToken: string): Promise<void> {
    this.tokens.set(destination, setupToken);
    const [name = '', domain = ''] = destination.split('@');
    const masked = `${name.slice(0, 2)}***@${domain}`;
    console.info(
      `MilkTrack development owner enrollment for ${masked}: ${setupToken}`,
    );
    return Promise.resolve();
  }

  takeLastTokenForTest(email: string): string | undefined {
    const token = this.tokens.get(email);
    this.tokens.delete(email);
    return token;
  }
}
