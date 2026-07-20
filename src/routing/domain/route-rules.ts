import { ApplicationError } from '../../common/errors/application.error.js';

export function normalizeRouteCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/u.test(code))
    throw new ApplicationError('INVALID_ROUTE_CODE', 'Route code is invalid', 400);
  return code;
}

export function normalizeRouteName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 100)
    throw new ApplicationError('INVALID_ROUTE_NAME', 'Route name must be between 1 and 100 characters', 400);
  return name;
}

export function normalizeRouteReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 3 || reason.length > 500)
    throw new ApplicationError('INVALID_REASON', 'Reason must be between 3 and 500 characters', 400);
  return reason;
}
