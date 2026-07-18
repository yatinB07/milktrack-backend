import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function decodeSegment(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid secret-box encoding');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error('Invalid secret-box encoding');
  return decoded;
}

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('MFA encryption key must be 32 bytes');
  }

  /** Encrypts UTF-8 text as canonical base64url IV, tag, and ciphertext segments. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((part) => part.toString('base64url'))
      .join('.');
  }

  /** Authenticates before returning plaintext; malformed or tampered values throw. */
  decrypt(encoded: string): string {
    const segments = encoded.split('.');
    if (segments.length !== 3) throw new Error('Invalid secret-box encoding');
    const iv = decodeSegment(segments[0]);
    const tag = decodeSegment(segments[1]);
    const ciphertext = decodeSegment(segments[2]);
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid secret-box encoding');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
