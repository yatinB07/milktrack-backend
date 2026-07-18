import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { requestContextStore } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { PasswordHasher, type PasswordHash } from '../../identity/domain/password.js';
import { SecretBox } from '../../identity/domain/secret-box.js';
import { TokenSecrets } from '../../identity/domain/token-hash.js';
import { Totp } from '../../identity/domain/totp.js';

export type OwnerEnrollmentResult = Readonly<{
  vendorId: string;
  userId: string;
  membershipId: string;
}>;

export abstract class OwnerEnrollmentStore {
  abstract start(input: Readonly<{
    setupTokenHash: string;
    completionTokenHash: string;
    now: Date;
    password: PasswordHash;
    encryptedMfaSecret: string;
    correlationId: string;
    ipHash?: string;
    deviceId?: string;
  }>): Promise<'success' | 'invalid'>;
  abstract complete(input: Readonly<{
    completionTokenHash: string;
    now: Date;
    verifyCode: (encryptedMfaSecret: string) => boolean;
    mfaFactorId: string;
    correlationId: string;
    ipHash?: string;
    deviceId?: string;
  }>): Promise<OwnerEnrollmentResult | 'invalid' | 'owner_exists'>;
}

export abstract class OwnerEnrollmentService {
  abstract start(
    setupToken: string,
    password: string,
  ): Promise<Readonly<{ completionToken: string; totpSecret: string }>>;
  abstract complete(completionToken: string, code: string): Promise<OwnerEnrollmentResult>;
}

export type OwnerEnrollmentConfiguration = Readonly<{
  authHmacKey: Buffer;
  mfaEncryptionKey: Buffer;
}>;

function invalidEnrollment(): ApplicationError {
  return new ApplicationError(
    'OWNER_ENROLLMENT_INVALID',
    'Owner enrollment is invalid or expired',
    401,
  );
}

@Injectable()
export class DefaultOwnerEnrollmentService extends OwnerEnrollmentService {
  private readonly tokens: TokenSecrets;
  private readonly secrets: SecretBox;
  private readonly passwords = new PasswordHasher();
  private readonly totp = new Totp();

  constructor(
    @Inject(OwnerEnrollmentStore) private readonly store: OwnerEnrollmentStore,
    configuration: OwnerEnrollmentConfiguration,
  ) {
    super();
    this.tokens = new TokenSecrets(configuration.authHmacKey);
    this.secrets = new SecretBox(configuration.mfaEncryptionKey);
  }

  async start(
    setupToken: string,
    password: string,
  ): Promise<Readonly<{ completionToken: string; totpSecret: string }>> {
    if (password.length < 12 || password.length > 128) {
      throw new ApplicationError(
        'INVALID_PASSWORD',
        'Password must be between 12 and 128 characters',
        400,
      );
    }
    const context = requestContextStore.require();
    const totpSecret = this.totp.generateSecret();
    const completionToken = this.tokens.issue();
    const outcome = await this.store.start({
      setupTokenHash: this.tokens.hash(setupToken),
      completionTokenHash: this.tokens.hash(completionToken),
      now: new Date(),
      password: await this.passwords.hash(password),
      encryptedMfaSecret: this.secrets.encrypt(totpSecret),
      correlationId: context.correlationId,
      ...(context.ipHash ? { ipHash: context.ipHash } : {}),
      ...(context.deviceId ? { deviceId: context.deviceId } : {}),
    });
    if (outcome === 'invalid') throw invalidEnrollment();
    return { completionToken, totpSecret };
  }

  async complete(
    completionToken: string,
    code: string,
  ): Promise<OwnerEnrollmentResult> {
    const context = requestContextStore.require();
    const outcome = await this.store.complete({
      completionTokenHash: this.tokens.hash(completionToken),
      now: new Date(),
      verifyCode: (encryptedSecret) => {
        try {
          return this.totp.verify(this.secrets.decrypt(encryptedSecret), code);
        } catch {
          return false;
        }
      },
      mfaFactorId: randomUUID(),
      correlationId: context.correlationId,
      ...(context.ipHash ? { ipHash: context.ipHash } : {}),
      ...(context.deviceId ? { deviceId: context.deviceId } : {}),
    });
    if (outcome === 'invalid') throw invalidEnrollment();
    if (outcome === 'owner_exists') {
      throw new ApplicationError(
        'VENDOR_OWNER_EXISTS',
        'The vendor already has an active owner',
        409,
      );
    }
    return outcome;
  }
}
