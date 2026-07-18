import { ApplicationError } from '../errors/application.error.js';

export type CursorValue = Readonly<{ createdAt: Date; id: string }>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CursorCodec {
  encode(value: CursorValue): string {
    return Buffer.from(
      JSON.stringify([value.createdAt.toISOString(), value.id]),
    ).toString('base64url');
  }

  decode(cursor: string): CursorValue {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const decoded = Buffer.from(cursor, 'base64url');
      if (decoded.toString('base64url') !== cursor) throw new Error();

      const parsed: unknown = JSON.parse(decoded.toString('utf8'));
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        typeof parsed[0] !== 'string' ||
        typeof parsed[1] !== 'string' ||
        new Date(parsed[0]).toISOString() !== parsed[0] ||
        !UUID_PATTERN.test(parsed[1])
      ) {
        throw new Error();
      }
      return { createdAt: new Date(parsed[0]), id: parsed[1] };
    } catch {
      throw new ApplicationError('INVALID_CURSOR', 'Cursor is invalid', 400);
    }
  }

  parseLimit(value?: number): number {
    const limit = value ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApplicationError(
        'INVALID_PAGINATION',
        'Limit must be between 1 and 100',
        400,
      );
    }
    return limit;
  }
}
