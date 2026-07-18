import { createHmac, timingSafeEqual } from 'node:crypto';

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
  validateSecret(secretBase32: string): void {
    decodeBase32(secretBase32);
  }

  /** Verifies a six-digit SHA-1 TOTP in the current 30-second step or either neighbor. */
  verify(secretBase32: string, code: string, timeMs = Date.now()): boolean {
    if (!/^\d{6}$/.test(code) || !Number.isFinite(timeMs) || timeMs < 0) return false;
    const secret = decodeBase32(secretBase32);
    const counter = Math.floor(timeMs / 30_000);
    const supplied = Buffer.from(code, 'ascii');
    for (const offset of [-1, 0, 1]) {
      if (
        counter + offset >= 0 &&
        timingSafeEqual(supplied, Buffer.from(codeAt(secret, counter + offset), 'ascii'))
      ) {
        return true;
      }
    }
    return false;
  }
}
