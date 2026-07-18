export interface AuthenticationEnvironment {
  readonly AUTH_HMAC_KEY?: string;
  readonly MFA_ENCRYPTION_KEY?: string;
}

export interface AuthenticationKeys {
  readonly authHmacKey: Buffer;
  readonly mfaEncryptionKey: Buffer;
}

function exactBase64Key(name: string, value: string | undefined): Buffer {
  if (value === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${name} must be canonical base64 encoding exactly 32 bytes`);
  }
  const key = Buffer.from(value, 'base64');
  if (key.toString('base64') !== value || key.length !== 32) {
    throw new Error(`${name} must be canonical base64 encoding exactly 32 bytes`);
  }
  return key;
}

/** Validates and decodes authentication keys without exposing their values. */
export function validateAuthenticationEnvironment(
  environment: AuthenticationEnvironment,
): AuthenticationKeys {
  return {
    authHmacKey: exactBase64Key('AUTH_HMAC_KEY', environment.AUTH_HMAC_KEY),
    mfaEncryptionKey: exactBase64Key(
      'MFA_ENCRYPTION_KEY',
      environment.MFA_ENCRYPTION_KEY,
    ),
  };
}
