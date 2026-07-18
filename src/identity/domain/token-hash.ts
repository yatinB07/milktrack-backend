import { createHmac, randomBytes } from 'node:crypto';

export class TokenSecrets {
  constructor(private readonly hmacKey: Buffer) {
    if (hmacKey.length !== 32) throw new Error('Token HMAC key must be 32 bytes');
  }

  /** Issues a 256-bit opaque bearer token; persist only the result of hash(). */
  issue(): string {
    return randomBytes(32).toString('base64url');
  }

  hash(token: string): string {
    return createHmac('sha256', this.hmacKey).update(token, 'utf8').digest('hex');
  }
}
