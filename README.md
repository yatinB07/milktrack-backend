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

PostgreSQL stores data in the named `postgres_data` volume. The volume survives
container restart or recreation, host reboot, and normal `docker compose down`.
Repository test and cleanup instructions never delete the default development
volume. Back up local data and use an independently reviewed recovery procedure
if an intentional reset is ever required.

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

Vendor managers onboard customers and delivery agents through
`POST /v1/vendors/{vendorId}/memberships/onboard` with a display name, E.164
phone number, and one of those two roles. The operation reuses the canonical
phone identity when it already exists, creates an invited membership for an
unverified phone, and returns an active membership when that phone is already
verified. The first successful phone OTP verification activates eligible
invitations before issuing the session. Direct membership creation or role
changes cannot bypass this flow and return `MEMBERSHIP_ONBOARDING_REQUIRED` for
customer or delivery-agent roles. Membership directory reads support `role`,
`status`, and `search` across display name, phone, and email. A searched request
examines one stable candidate page only (at most 100 memberships), enriches that
page once through Identity, and filters it in memory. Its continuation cursor is
after the last examined candidate, so a page can contain fewer matches than its
requested limit while still returning `nextCursor`; clients should follow that
cursor to continue the search.

Authentication authority checks do not scan vendors. Narrow, parameterized
database functions resolve only the requested user's eligible membership facts,
active authorization memberships, or activated invitation IDs. Platform roles
remain a separate exact-user lookup. Unknown users are rejected before these
authority lookups, and invitation activation plus its tenant audits remains one
atomic transaction.

## Schedule worker

The API and schedule worker are separate entry points in the same image. The
worker runs `npm run start:worker` in production or `npm run start:worker:dev`
from source. Compose starts it without an HTTP server, health endpoint, published
port, authentication keys, or database-owner credential; it receives only the
restricted runtime database URL and worker settings.

| Setting | Default | Allowed range |
|---|---:|---:|
| `POLL_INTERVAL_MS` | `5000` | `250`–`60000` |
| `CONCURRENCY` | `4` | `1`–`32` |
| `SHUTDOWN_TIMEOUT_MS` | `60000` | `1000`–`60000` |

The worker seeds a rolling seven-day horizon in each eligible vendor timezone,
claims due generation runs, and processes at bounded concurrency. Claims use a
60-second lease, a fixed 20-second renewal heartbeat, and an ID/token/attempt
fence so an expired or superseded worker cannot commit. Retryable failures use
bounded backoff for at most five attempts. Worker logs use fixed safe event
codes, and public failures use the stable `SCHEDULE_GENERATION_FAILED` envelope
instead of exposing internal exceptions. `SIGINT` and `SIGTERM` stop new work,
allow active work to drain up to the configured timeout, and close the Nest
application context.

## Verification

Run no-database checks without starting Compose dependencies:

```bash
docker compose --env-file .env run --rm --no-deps backend npm test
docker compose --env-file .env run --rm --no-deps backend npm run verify
docker compose --env-file .env run --rm --no-deps backend npm run db:validate
sh test/compose-contract.sh
```

Database and release gates own uniquely named Compose projects, load
`.env.example`, reject inherited database/project overrides, and remove only
their disposable volumes:

```bash
sh test/integration-release.sh
sh test/security-release.sh
npm run test:migration-drift
npm run test:openapi-compatibility
sh test/retained-volume-contract.sh
docker build --target production -t milktrack-backend:production .
sh test/runtime-contract.sh milktrack-backend:production
P2_VOLUME_GATE=1 npm run test:schedule-volume
```

Integration, security, migration drift, runtime, and retained-volume gates are
safe public entry points; the raw database test scripts refuse direct use. The
200,000-subscription schedule-volume gate is an explicit release check rather
than a normal CI step and requires `P2_VOLUME_GATE=1`.

`test/security-release.sh` creates an isolated temporary database volume,
validates the migration path and retained records, and runs the release-blocking
RLS, cross-tenant, privilege, session, authentication, and audit checks. It
removes only its own temporary volume.

The default `milktrack-backend` Compose project and its `postgres_data` volume
are persistent development state. Database-mutating tests never use them, and
repository cleanup never runs `down -v` against them. The retained-volume gate
takes only its disposable project down and back up before proving migration
history survives container recreation. Do not substitute the default project
name into a release wrapper, and never run `docker compose down -v`, volume
deletion, or pruning against the default development project.

CI installs from the lockfile, runs lint/type-check/unit/build verification,
validates Prisma, deploys all 21 migrations to an empty database, runs integration
and security tests, checks OpenAPI and Compose drift, audits the production
dependency set, probes the production image contract, and always tears down its
isolated stack. A failure in any of these gates blocks release.

Build and inspect the least-privileged production image. The runtime contract
provisions and removes its own isolated PostgreSQL project:

```bash
docker build --target production -t milktrack-backend:production .
docker run --rm --entrypoint npm milktrack-backend:production audit --omit=dev --omit=optional
sh test/runtime-contract.sh milktrack-backend:production
```

The committed images are fixed for reproducible builds: PostgreSQL 18.4 and
Node.js 24.18.0 are both pinned by digest. Update each pin through a reviewed
dependency change, not an unversioned production pull.

## OpenAPI contract

Household management is available under `/v1/vendors/{vendorId}/households`,
with customer self reads under `/v1/customer/vendors/{vendorId}/households`.
Vendor catalog management is available under `/v1/vendors/{vendorId}/units`
and `/v1/vendors/{vendorId}/products`, with vendor-local delivery slots under
`/v1/vendors/{vendorId}/delivery-slots`. Catalog lists default to active records
and accept bounded opaque cursors plus explicit status and search filters.
Product status changes use PATCH; delete/restore use optimistic versions, and
product creation intentionally does not accept `expectedVersion`. Delivery-slot
codes and `HH:mm` local time windows are immutable; only names can be changed,
and deactivate/reactivate requires a reason.

Effective-dated global prices and household final-price overrides are available
under the vendor pricing routes. Amounts cross JSON as non-negative decimal
integer strings, while currency is derived from the vendor. Price periods are
half-open and append-only: an open row can be closed once with a reason, and a
new row records a price change. Resolution uses the vendor timezone, service
date, and delivery-slot start; household overrides take precedence over global
prices, and no match returns an explicit `missing` result. Customer resolution
requires active membership in the routed household and never exposes raw price
history or source row IDs.

Effective-dated milk subscriptions are available under
`/v1/vendors/{vendorId}/subscriptions`, with household-scoped customer reads
under `/v1/customer/vendors/{vendorId}/households/{householdId}/subscriptions`.
Quantities cross JSON as canonical decimal strings. Weekdays use unique ISO
values `1` through `7`, API end dates are inclusive, and lifecycle changes use
vendor-local effective dates plus optimistic root versions. Modify, pause,
resume, and cancel retain superseded revision history; pause and cancel remain
available when retained household or catalog references later become inactive.
Only cancelled or completed roots can be soft-deleted, and restore exposes the
same terminal history without resuming service. Customer responses require an
active household membership and omit creator IDs and internal supersession
reasons.

Vendor subscription lists filter by `householdId`, `productId`,
`deliverySlotId`, operational `status`, and the effective `routeId` plus
`routeServiceDate` pair. Customer lists retain the product, slot, and status
filters within their authorized household. Household discovery supports
case-insensitive `search` across account number, name, address, city, and postal
code plus explicit active/inactive status. Route discovery supports status,
delivery slot, and code/name search. Route-stop reads are effective-dated and
return each stop's ordered household summary, including delivery address and
coordinates, without exposing household notes or membership data.

Routes support lifecycle, effective ordered stop plans, dated agent assignments,
and agent-self assignment reads. Active subscription projections feed retained
scheduled deliveries. Vendor managers can synchronously request a date within
the seven-day horizon through
`POST /v1/vendors/{vendorId}/schedule-generation-runs/manual`; authorized readers
list runs with `trigger`, `status`, `serviceDate`, and cursor filters through
`GET /v1/vendors/{vendorId}/schedule-generation-runs`. Responses expose safe
counts and retry state but never lease tokens or owner credentials.

Use the existing Compose migration and integration commands after applying all
committed Phase 2 migrations.

The committed contract is `openapi/v1.json`. Regenerate it from the same Nest
application and Swagger configuration used at runtime, then check for drift:

```bash
docker compose --env-file .env run --rm --no-deps \
  --volume "$PWD/openapi:/app/openapi" \
  backend npm run openapi:generate
docker compose --env-file .env run --rm --no-deps backend npm run openapi:check
```

Review and commit intentional contract changes before updating generated clients
in the web or mobile repositories. Tagged backend releases publish this artifact;
consumers pin a compatible backend contract and must not edit generated types.
`npm run test:openapi-compatibility` verifies the immutable web and mobile
baselines and rejects semantic breaking changes before release.

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
