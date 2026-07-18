import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function encodeBase32(value: Buffer): string {
  let bits = 0;
  let buffer = 0;
  let result = '';
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(buffer >>> bits) & 0x1f];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  return result;
}

function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase();
  const match = /^([A-Z2-7]+)(=*)$/.exec(normalized);
  if (match === null) throw new Error('TOTP secret must use RFC 4648 base32');
  const data = match[1];
  const padding = match[2].length;
  const remainder = data.length % 8;
  const expectedPadding = new Map([
    [0, 0],
    [2, 6],
    [4, 4],
    [5, 3],
    [7, 1],
  ]).get(remainder);
  if (expectedPadding === undefined || (padding !== 0 && padding !== expectedPadding)) {
    throw new Error('TOTP secret must use RFC 4648 base32');
  }

  const bytes: number[] = [];
  let bits = 0;
  let buffer = 0;
  for (const character of data) {
    buffer = (buffer << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) throw new Error('TOTP secret has non-zero trailing bits');
  return Buffer.from(bytes);
}

function codeAt(secret: Buffer, counter: number): string {
  const value = Buffer.alloc(8);
  value.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(value).digest();
  const offset = digest.at(-1)! & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000)
    .toString()
    .padStart(6, '0');
}

export class Totp {
  generateSecret(): string {
    return encodeBase32(randomBytes(20));
  }

  validateSecret(secretBase32: string): void {
    decodeBase32(secretBase32);
  }

  /** Verifies a six-digit SHA-1 TOTP in the current 30-second step or either neighbor. */
  verify(secretBase32: string, code: string, timeMs = Date.now()): boolean {
    return this.matchingCounter(secretBase32, code, timeMs) !== undefined;
  }

  /** Returns the accepted counter so callers can enforce one-time use across challenges. */
  matchingCounter(secretBase32: string, code: string, timeMs = Date.now()): number | undefined {
    if (!/^\d{6}$/.test(code) || !Number.isFinite(timeMs) || timeMs < 0) return undefined;
    const secret = decodeBase32(secretBase32);
    const counter = Math.floor(timeMs / 30_000);
    const supplied = Buffer.from(code, 'ascii');
    for (const offset of [-1, 0, 1]) {
      if (
        counter + offset >= 0 &&
        timingSafeEqual(supplied, Buffer.from(codeAt(secret, counter + offset), 'ascii'))
      ) {
        return counter + offset;
      }
    }
    return undefined;
  }
}
