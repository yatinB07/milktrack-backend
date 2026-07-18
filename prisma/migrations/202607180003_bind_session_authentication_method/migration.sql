CREATE TYPE "AuthenticationMethod" AS ENUM ('phone_otp', 'administrator_mfa');

ALTER TABLE "sessions"
ADD COLUMN "authentication_method" "AuthenticationMethod" NOT NULL DEFAULT 'phone_otp';

-- Existing sessions predate assurance binding, so their authentication method is unknowable.
UPDATE "sessions"
SET "access_expires_at" = LEAST("access_expires_at", CURRENT_TIMESTAMP),
    "expires_at" = LEAST("expires_at", CURRENT_TIMESTAMP);

ALTER TABLE "sessions" ALTER COLUMN "authentication_method" DROP DEFAULT;
