import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { Actor } from '../../common/context/request-context.js';
import { requestContextStore } from '../../common/context/request-context.js';
import { ApplicationError } from '../../common/errors/application.error.js';
import { OtpCodes } from '../domain/otp.js';
import { normalizeEmail, normalizePhone } from '../domain/identity-normalization.js';
import { PasswordHasher } from '../domain/password.js';
import { SecretBox } from '../domain/secret-box.js';
import { TokenSecrets } from '../domain/token-hash.js';
import { Totp } from '../domain/totp.js';
import type { PrismaIdentityStore } from '../infrastructure/prisma-identity.store.js';
import type { OtpDelivery } from './otp-delivery.js';

export type RequestPhoneOtpCommand = Readonly<{
  phone: string;
  purpose: 'sign_in';
  ipHash?: string;
}>;
export type PhoneOtpChallenge = Readonly<{
  accepted: true;
  challengeToken: string;
  expiresAt: Date;
}>;
export type VerifyPhoneOtpCommand = Readonly<{
  challengeToken: string;
  code: string;
  deviceId: string;
  deviceName?: string;
  ipHash?: string;
}>;
export type StartAdministratorSignInCommand = Readonly<{
  email: string;
  password: string;
  deviceId: string;
  deviceName?: string;
  ipHash?: string;
}>;
export type PendingMfaCredential = Readonly<{
  pendingMfaToken: string;
  expiresAt: Date;
}>;
export type VerifyAdministratorMfaCommand = Readonly<{
  pendingMfaToken: string;
  code: string;
  deviceId: string;
  deviceName?: string;
  ipHash?: string;
}>;
export type SessionTokens = Readonly<{
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}>;

export abstract class AuthenticationService {
  abstract requestPhoneOtp(command: RequestPhoneOtpCommand): Promise<PhoneOtpChallenge>;
  abstract verifyPhoneOtp(command: VerifyPhoneOtpCommand): Promise<SessionTokens>;
  abstract startAdministratorSignIn(
    command: StartAdministratorSignInCommand,
  ): Promise<PendingMfaCredential>;
  abstract verifyAdministratorMfa(
    command: VerifyAdministratorMfaCommand,
  ): Promise<SessionTokens>;
  abstract refresh(refreshToken: string, deviceId: string): Promise<SessionTokens>;
  abstract authenticate(accessToken: string): Promise<Actor>;
  abstract logout(accessToken: string): Promise<void>;
  abstract logoutAll(accessToken: string): Promise<void>;
}

export type AuthenticationConfiguration = Readonly<{
  authHmacKey: Buffer;
  mfaEncryptionKey: Buffer;
  sessionTtlSeconds: number;
}>;

const FIVE_MINUTES = 300_000;
const ACCESS_LIFETIME = 900_000;

function authenticationFailed(): ApplicationError {
  return new ApplicationError(
    'AUTHENTICATION_FAILED',
    'Authentication failed',
    401,
  );
}

@Injectable()
export class PrismaAuthenticationService extends AuthenticationService {
  private readonly tokens: TokenSecrets;
  private readonly otpCodes: OtpCodes;
  private readonly passwords = new PasswordHasher();
  private readonly secrets: SecretBox;
  private readonly totp = new Totp();
  private readonly dummyPassword;

  constructor(
    private readonly store: PrismaIdentityStore,
    private readonly delivery: OtpDelivery,
    private readonly configuration: AuthenticationConfiguration,
  ) {
    super();
    if (!Number.isInteger(configuration.sessionTtlSeconds) || configuration.sessionTtlSeconds <= 0) {
      throw new Error('SESSION_TTL_SECONDS must be a positive integer');
    }
    this.tokens = new TokenSecrets(configuration.authHmacKey);
    this.otpCodes = new OtpCodes(configuration.authHmacKey);
    this.secrets = new SecretBox(configuration.mfaEncryptionKey);
    this.dummyPassword = this.passwords.hash('MilkTrack timing-only password');
  }

  async requestPhoneOtp(command: RequestPhoneOtpCommand): Promise<PhoneOtpChallenge> {
    const phone = normalizePhone(command.phone);
    const challengeToken = this.tokens.issue();
    const code = this.otpCodes.generate();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + FIVE_MINUTES);
    const outcome = await this.store.createOtpChallenge({
      id: randomUUID(),
      tokenHash: this.tokens.hash(challengeToken),
      destinationHash: this.tokens.hash(phone),
      normalizedPhone: phone,
      codeHash: this.otpCodes.hash(code),
      purpose: command.purpose,
      ipHash: command.ipHash,
      now,
      expiresAt,
      correlationId: this.correlationId(),
    });
    if (outcome.kind === 'rate_limited') {
      throw new ApplicationError(
        'RATE_LIMITED',
        'Try again later',
        429,
        true,
        outcome.retryAfterSeconds,
      );
    }
    const delivery = outcome.deliver
      ? this.delivery.send(phone, code)
      : Promise.resolve();
    void delivery.catch(() => undefined);
    await Promise.resolve();
    return { accepted: true, challengeToken, expiresAt };
  }

  async verifyPhoneOtp(command: VerifyPhoneOtpCommand): Promise<SessionTokens> {
    const issued = this.issueSession(command.deviceId, command.deviceName, command.ipHash);
    const outcome = await this.store.verifyPhoneOtp({
      tokenHash: this.tokens.hash(command.challengeToken),
      verifyCode: (expectedHash) => this.otpCodes.verify(command.code, expectedHash),
      now: new Date(),
      session: issued.persisted,
      authenticationMethod: 'phone_otp',
      correlationId: this.correlationId(),
    });
    if (outcome !== 'success') throw authenticationFailed();
    return issued.tokens;
  }

  async startAdministratorSignIn(
    command: StartAdministratorSignInCommand,
  ): Promise<PendingMfaCredential> {
    const email = normalizeEmail(command.email);
    const pendingMfaToken = this.tokens.issue();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + FIVE_MINUTES);
    const outcome = await this.store.startAdministratorSignIn({
      id: randomUUID(),
      accountKey: this.tokens.hash(email),
      normalizedEmail: email,
      tokenHash: this.tokens.hash(pendingMfaToken),
      deviceId: command.deviceId,
      verifyPassword: async (credential) =>
        this.passwords.verify(
          command.password,
          credential ?? (await this.dummyPassword),
        ),
      now,
      expiresAt,
      ipHash: command.ipHash,
      correlationId: this.correlationId(),
    });
    if (outcome.kind === 'rate_limited') {
      throw new ApplicationError(
        'RATE_LIMITED',
        'Try again later',
        429,
        true,
        outcome.retryAfterSeconds,
      );
    }
    if (outcome.kind === 'failed') throw authenticationFailed();
    return { pendingMfaToken, expiresAt };
  }

  async verifyAdministratorMfa(
    command: VerifyAdministratorMfaCommand,
  ): Promise<SessionTokens> {
    const issued = this.issueSession(command.deviceId, command.deviceName, command.ipHash);
    const outcome = await this.store.verifyAdministratorMfa({
      tokenHash: this.tokens.hash(command.pendingMfaToken),
      deviceId: command.deviceId,
      now: new Date(),
      verifyCode: (encryptedSecret) => {
        try {
          return this.totp.matchingCounter(
            this.secrets.decrypt(encryptedSecret),
            command.code,
          );
        } catch {
          return undefined;
        }
      },
      ipHash: command.ipHash,
      session: issued.persisted,
      authenticationMethod: 'administrator_mfa',
      correlationId: this.correlationId(),
    });
    if (outcome !== 'success') throw authenticationFailed();
    return issued.tokens;
  }

  async refresh(refreshToken: string, deviceId: string): Promise<SessionTokens> {
    const issued = this.issueSession(deviceId);
    const outcome = await this.store.rotateSession({
      refreshTokenHash: this.tokens.hash(refreshToken),
      deviceId,
      now: new Date(),
      successor: issued.persisted,
      correlationId: this.correlationId(),
    });
    if (outcome !== 'success') throw authenticationFailed();
    return issued.tokens;
  }

  async authenticate(accessToken: string): Promise<Actor> {
    const actor = await this.store.authenticate(
      this.tokens.hash(accessToken),
      new Date(),
    );
    if (!actor) throw authenticationFailed();
    return actor;
  }

  async logout(accessToken: string): Promise<void> {
    const success = await this.store.logout(
      this.tokens.hash(accessToken),
      new Date(),
      this.correlationId(),
    );
    if (!success) throw authenticationFailed();
  }

  async logoutAll(accessToken: string): Promise<void> {
    const success = await this.store.logoutAll(
      this.tokens.hash(accessToken),
      new Date(),
      this.correlationId(),
    );
    if (!success) throw authenticationFailed();
  }

  private issueSession(deviceId: string, deviceName?: string, ipHash?: string) {
    const now = new Date();
    const accessToken = this.tokens.issue();
    const refreshToken = this.tokens.issue();
    const accessExpiresAt = new Date(now.getTime() + ACCESS_LIFETIME);
    const refreshExpiresAt = new Date(
      now.getTime() + this.configuration.sessionTtlSeconds * 1_000,
    );
    return {
      tokens: { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt },
      persisted: {
        id: randomUUID(),
        accessTokenHash: this.tokens.hash(accessToken),
        refreshTokenHash: this.tokens.hash(refreshToken),
        deviceId,
        deviceName,
        ipHash,
        accessExpiresAt,
        expiresAt: refreshExpiresAt,
        lastSeenAt: now,
      },
    } as const;
  }

  private correlationId(): string {
    return requestContextStore.get()?.correlationId ?? randomUUID();
  }
}
