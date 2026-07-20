# MilkTrack backend

MilkTrack's backend is a NestJS modular monolith. It owns the versioned HTTP
API, business and authorization rules, PostgreSQL schema and migrations, and
the OpenAPI contract consumed by the web and mobile repositories.

## Prerequisites and configuration

Docker with Docker Compose is the only server-side prerequisite. Host Node.js
and PostgreSQL are not required.

```bash
cp .env.example .env
```

`.env.example` contains local-only placeholders. Keep `.env` ignored and inject
separate production values through the deployment platform. In particular:

- `MIGRATION_DATABASE_URL` uses the database owner. Compose injects it into the
  one-shot migration service and into the test-only integration service as
  `TEST_OWNER_DATABASE_URL`; the backend service never receives either value.
- `DATABASE_URL` uses the restricted runtime role without `BYPASSRLS`.
  Its username is fixed as `milktrack_app` because committed migrations grant
  privileges to that role; only its injected password is configurable.
- `AUTH_HMAC_KEY` and `MFA_ENCRYPTION_KEY` must each be an independently
  generated, canonical Base64 encoding of exactly 32 bytes.
- `SESSION_TTL_SECONDS` controls the expiry of each issued refresh session; a
  successful refresh creates a new session with a new expiry.
- `TRUST_PROXY_CIDRS` is empty for direct local access. Production deployments
  set a comma-separated list of reviewed proxy or ingress IP addresses/CIDRs;
  catch-all `/0` networks are rejected. The ingress must strip or overwrite
  forwarding headers from clients, and topology changes require allowlist review.
- `OTP_PROVIDER=local` is permitted only when `APP_ENV` is `development` or
  `test`. It serves both phone OTP and owner-enrollment delivery. A real provider
  adapter and injected provider credentials are required before a production
  deployment can start.

Never commit credentials, OTPs, TOTP seeds, access or refresh tokens, customer
data, or production database URLs.

## Start and stop

Start PostgreSQL, apply all committed migrations, and start the API:

```bash
docker compose --env-file .env up --build --wait --wait-timeout 120
```

The health endpoint is `http://localhost:3000/v1/health`. The live Swagger UI
is at `http://localhost:3000/openapi`, and its JSON is at
`http://localhost:3000/openapi.json`.

Stop the stack while preserving its database:

```bash
docker compose --env-file .env down
```

Delete the containers **and all local PostgreSQL data** only for an intentional
reset:

```bash
docker compose --env-file .env down -v
```

PostgreSQL stores data in the named `postgres_data` volume. The volume survives
container restart or recreation, host reboot, and normal `docker compose down`.
It is not a backup and can be removed by `down -v`, explicit volume deletion, or
volume pruning.

## Database operations

Apply committed migrations explicitly when the stack is already running:

```bash
docker compose --env-file .env run --rm migrate
```

Open a PostgreSQL shell as the local database owner without publishing the
database port:

```bash
docker compose --env-file .env exec postgres sh -c \
  'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"'
```

Confirm that data remains available after a database-container restart:

```bash
docker compose --env-file .env exec postgres sh -c \
  'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command "SELECT count(*) FROM vendors;"'
docker compose --env-file .env restart postgres
docker compose --env-file .env exec postgres sh -c \
  'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command "SELECT count(*) FROM vendors;"'
```

### Development seed

The seed is limited to development/test, requires an `example.test` email,
requires a 12–1024 character password and a valid Base32 TOTP secret, and is
idempotent for its fixed development identities. Supply values from the shell
instead of writing them to `.env` or command history:

```bash
read -r SEED_ADMIN_EMAIL
read -rs SEED_ADMIN_PASSWORD
read -rs SEED_TOTP_SECRET
export SEED_ADMIN_EMAIL SEED_ADMIN_PASSWORD SEED_TOTP_SECRET
docker compose --env-file .env run --rm \
  -e SEED_ADMIN_EMAIL -e SEED_ADMIN_PASSWORD -e SEED_TOTP_SECRET \
  backend npm run db:seed
unset SEED_ADMIN_EMAIL SEED_ADMIN_PASSWORD SEED_TOTP_SECRET
```

The seed creates a platform administrator, a Product Owner, isolated Vendor A
and Vendor B owners, and Vendor A delivery-agent and customer accounts for the
mobile login flows. It uses production password hashing and TOTP encryption;
the database stores no plaintext password or TOTP secret.

- Delivery agent: `+91 98765 43210`
- Customer: `+91 98765 43211`

## Local authentication delivery

With `APP_ENV=development` and `OTP_PROVIDER=local`, requested phone OTPs are
written to backend logs so development does not depend on provider API keys:

```bash
docker compose --env-file .env logs -f backend
```

The log masks the destination but contains the short-lived OTP. Treat local
logs as sensitive and never enable this provider in production. PostgreSQL
stores only HMAC-protected challenge values, attempt/expiry state, and hashed
request metadata—not the plaintext OTP.

Initial vendor-owner invitations use the same local-only provider setting. A
platform administrator with MFA creates the invitation; the backend logs the
30-minute setup token with a masked email destination. The invited owner uses
that one-time token to choose a password, receives a generated TOTP secret, and
confirms a current TOTP code before the owner membership becomes active.

Local owner-enrollment delivery is in-process and intentionally has no email
provider, queue, or worker. A failed send is attempted once more immediately and
then remains `failed`. The protected retry endpoint rotates the setup token and
expiry before another delivery attempt, so the previous token stops working.
Treat these logs as credentials and do not use this adapter outside development
or test.

## Verification

Run the repository checks in its own Compose project:

```bash
docker compose --env-file .env run --rm backend npm test
docker compose --env-file .env run --rm backend npm run verify
docker compose --env-file .env run --rm backend npm run db:validate
docker compose --profile test --env-file .env run --rm integration npm run test:integration
bash test/security-release.sh
bash test/compose-contract.sh
COMPOSE_PROJECT_NAME=milktrack-retained-contract bash test/retained-volume-contract.sh
COMPOSE_PROJECT_NAME=milktrack-retained-contract docker compose --env-file .env down -v --remove-orphans
```

`test/security-release.sh` creates an isolated temporary database volume,
validates the migration path and retained records, and runs the release-blocking
RLS, cross-tenant, privilege, session, authentication, and audit checks. It
removes only its own temporary volume.

`test/retained-volume-contract.sh` requires an explicit, isolated
`COMPOSE_PROJECT_NAME`. It deploys the current migration set, restarts PostgreSQL,
takes the Compose project down and back up, and confirms migration history was
retained. The following `down -v` removes only that named test project's volume.

CI installs from the lockfile, runs lint/type-check/unit/build verification,
validates Prisma, deploys every migration to an empty database, runs integration
and security tests, checks OpenAPI and Compose drift, audits the production
dependency set, probes the production image contract, and always tears down its
isolated stack. A failure in any of these gates blocks release.

With the Compose stack running, build and inspect the least-privileged
production image:

```bash
COMPOSE_PROJECT_NAME=milktrack-production-contract docker compose --env-file .env up --build -d --wait --wait-timeout 120
docker build --target production -t milktrack-backend:production .
docker run --rm --entrypoint npm milktrack-backend:production audit --omit=dev --omit=optional
COMPOSE_PROJECT_NAME=milktrack-production-contract bash test/runtime-contract.sh milktrack-backend:production
COMPOSE_PROJECT_NAME=milktrack-production-contract docker compose --env-file .env down
```

The committed images are fixed for reproducible builds: PostgreSQL 18.4 and
Node.js 24.18.0 are both pinned by digest. Update each pin through a reviewed
dependency change, not an unversioned production pull.

## OpenAPI contract

Household management is available under `/v1/vendors/{vendorId}/households`,
with customer self reads under `/v1/customer/vendors/{vendorId}/households`.
Vendor catalog management is available under `/v1/vendors/{vendorId}/units`
and `/v1/vendors/{vendorId}/products`. Catalog lists default to active records
and accept bounded opaque cursors plus explicit status and search filters.
Product status changes use PATCH; delete/restore use optimistic versions, and
product creation intentionally does not accept `expectedVersion`.

Use the existing Compose migration and integration commands after applying the
additive household and vendor-catalog migrations.

The committed contract is `openapi/v1.json`. Regenerate it from the same Nest
application and Swagger configuration used at runtime, then check for drift:

```bash
docker compose --env-file .env run --rm \
  --volume "$PWD/openapi:/app/openapi" \
  backend npm run openapi:generate
docker compose --env-file .env run --rm backend npm run openapi:check
```

Review and commit intentional contract changes before updating generated clients
in the web or mobile repositories. Tagged backend releases publish this artifact;
consumers pin a compatible backend contract and must not edit generated types.

## Operations and recovery

- Run a dedicated migration image/job with the migration credential before
  rolling out API replicas; that job invokes `npm run db:migrate:deploy`. For
  local Compose, use `docker compose --env-file .env run --rm migrate`. API
  containers must use only the runtime credential.
- Back up production PostgreSQL with the database platform, encrypt backups, and
  test restoration. The local Compose volume is not a production backup.
- Do not reverse an applied migration by editing or renaming its SQL. Prefer a
  reviewed forward migration; restore a verified database snapshot only under an
  approved incident procedure.
- Record and test production RPO/RTO, retention, provider monitoring, and secret
  rotation before launch. These values remain product/operations decisions, not
  application defaults.
- Preserve audit and historical rows during recovery. After restoration, deploy
  migrations, run health and security gates, and reconcile the recovery point
  before reopening writes.

See `ARCHITECTURE.md` for security boundaries and table ownership.
