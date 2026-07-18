import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const PARAMETERS = Object.freeze({ N: 16_384, r: 8, p: 1, keyLength: 64 });
const MAX_MEMORY = 64 * 1024 * 1024;

export interface PasswordHash {
  readonly hash: string;
  readonly salt: string;
  readonly parameters: typeof PARAMETERS;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      PARAMETERS.keyLength,
      { N: PARAMETERS.N, r: PARAMETERS.r, p: PARAMETERS.p, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function decodeCanonicalBase64(value: string, length: number): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === length && decoded.toString('base64') === value
    ? decoded
    : undefined;
}

export class PasswordHasher {
  /** Creates a fixed-cost scrypt hash with a fresh 16-byte salt. */
  async hash(password: string): Promise<PasswordHash> {
    const salt = randomBytes(16);
    return {
      hash: (await derive(password, salt)).toString('base64'),
      salt: salt.toString('base64'),
      parameters: PARAMETERS,
    };
  }

  /** Verifies only the current fixed scrypt encoding; malformed records are rejected. */
  async verify(password: string, encoded: PasswordHash): Promise<boolean> {
    if (
      encoded.parameters.N !== PARAMETERS.N ||
      encoded.parameters.r !== PARAMETERS.r ||
      encoded.parameters.p !== PARAMETERS.p ||
      encoded.parameters.keyLength !== PARAMETERS.keyLength
    ) {
      return false;
    }
    const salt = decodeCanonicalBase64(encoded.salt, 16);
    const expected = decodeCanonicalBase64(encoded.hash, PARAMETERS.keyLength);
    if (salt === undefined || expected === undefined) return false;
    return timingSafeEqual(await derive(password, salt), expected);
  }
}
