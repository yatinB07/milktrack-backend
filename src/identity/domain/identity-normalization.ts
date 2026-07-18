import { ApplicationError } from '../../common/errors/application.error.js';

export function normalizePhone(value: string): string {
  const normalized = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new ApplicationError('INVALID_PHONE', 'Phone number is invalid', 400);
  }
  return normalized;
}

export function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new ApplicationError('INVALID_EMAIL', 'Email address is invalid', 400);
  }
  return normalized;
}
