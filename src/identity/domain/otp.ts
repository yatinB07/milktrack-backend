import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export class OtpCodes {
  static readonly policy = Object.freeze({
    lifetimeSeconds: 300,
    maximumAttempts: 5,
    resendWindowSeconds: 60,
    maximumRequestsPerWindow: 5,
    requestWindowSeconds: 900,
  });

  constructor(private readonly hmacKey: Buffer) {
    if (hmacKey.length !== 32) throw new Error('OTP HMAC key must be 32 bytes');
  }

  generate(): string {
    return randomInt(1_000_000).toString().padStart(6, '0');
  }

  hash(code: string): string {
    return createHmac('sha256', this.hmacKey).update(code, 'utf8').digest('hex');
  }

  verify(code: string, expectedHash: string): boolean {
    if (!/^\d{6}$/.test(code) || !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
    return timingSafeEqual(
      Buffer.from(this.hash(code), 'hex'),
      Buffer.from(expectedHash, 'hex'),
    );
  }
}
