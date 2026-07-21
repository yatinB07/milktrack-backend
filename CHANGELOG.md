# Changelog

All notable backend changes are recorded here.

## [Unreleased]

### Added

- Added effective global and household-specific pricing with append-only periods,
  product/unit filters, vendor-local resolution, customer-safe precedence, and
  explicit missing-price results.
- Added effective-dated subscriptions with retained revisions, weekday plans,
  lifecycle transitions, customer-safe history, and household/product/slot/
  status plus effective route/date filtering.
- Added route definitions, effective ordered household stops with safe address
  summaries, dated agent assignments, agent-self reads, and filtered discovery.
- Added retained scheduled deliveries, manual and automatic generation runs,
  filtered run visibility, configuration-change regeneration, and the same-image
  no-port schedule worker with bounded polling, concurrency, leases, heartbeats,
  fencing, retries, and graceful shutdown.
- Added secure customer and delivery-agent phone onboarding, enriched membership
  directory filters, invitation activation on successful OTP verification, and
  support for eligible phone sessions during vendor trial.
- Bounded membership search to one stable candidate page of at most 100 rows,
  one Identity enrichment call, in-memory matching, and continuation after the
  last examined candidate.
- Added tenant-safe vendor-local delivery slots with canonical `HH:mm` windows,
  immutable codes/times, bounded filtered cursor pagination, row-locked reasoned
  lifecycle transitions, forced RLS, and atomic audits.
- Added tenant-safe vendor units and products with forced RLS, bounded filtered
  cursor pagination, immutable unit/product identifiers, optimistic product
  mutations, soft delete/restore, active-unit validation, and atomic audits.
- Added tenant-safe household and customer-membership management with forced RLS,
  soft deletion, cursor pagination, optimistic versions, and audited mutations.

- Added the production backend bootstrap, global DTO validation, stable error
  envelope, request correlation context, and versioned health contract.
- Added phone OTP and administrator password/TOTP MFA sign-in, opaque access and
  rotating refresh sessions, logout, logout-all, and authenticated actor APIs.
- Added initial vendor-owner invitation and owner-controlled password/TOTP setup,
  one-time completion, audited failed-delivery token rotation, immediate rejection
  of expired handles, lazy retirement on the next owner-establishment attempt,
  and concurrent-completion protection; no retirement scheduler or worker exists.
- Added separate platform and vendor roles, multi-role vendor memberships,
  scoped support authorization, and fail-closed security-denial auditing.
- Added platform vendor creation, cursor-paginated reads, optimistic lifecycle
  transitions, membership lifecycle, user delete/restore/deactivate, owner
  orphan protection, and tenant audit APIs.
- Added selective soft deletion for Phase 1 master records and append-only audit
  history for privileged and security-sensitive changes.
- Added the idempotent development/test security seed for a platform
  administrator, Product Owner, two isolated test vendors, and Vendor A mobile
  delivery-agent and customer accounts.
- Added the versioned deterministic OpenAPI artifact and contract drift check.

### Security

- Replaced authentication-time vendor scans with narrow exact-user database
  authority functions, fixed security-definer search paths, revoked public
  execution, runtime-only grants, and a partial current-membership lookup index.
- Kept invitation activation and its tenant audit inserts atomic while returning
  only activated membership/vendor IDs, and short-circuited unknown users before
  authority resolution.
- Prevented direct membership creation or role changes from bypassing the phone
  onboarding lifecycle for customers and delivery agents.
- Added fenced schedule-run transitions, fixed safe worker log codes, safe public
  generation failures, and response DTOs that omit leases and credentials.
- Added forced RLS, composite tenant integrity, cross-tenant tests, and narrow
  runtime grants for every Phase 2 pricing, subscription, routing, schedule, and
  generation-run table.
- Added bidirectional delivery-slot tenant isolation, runtime-role access and
  hard-delete denial checks, plus atomic rollback coverage for audit failure.
- Added composite tenant-safe product-to-unit integrity and bidirectional catalog
  RLS tests, including positive runtime-role access and hard-delete denial.
- Added forced PostgreSQL row-level security for vendor memberships, support
  grants, owner enrollments, and audit events using transaction-local tenant
  context.
- Added administrator account/IP throttling, aggregate MFA attempt limits, TOTP
  counter replay rejection, and automatic administrator-session revocation when
  an MFA factor is revoked.
- Preserved distinct client throttling identities behind explicitly allowlisted
  proxies while rejecting spoofed forwarding headers from untrusted peers.
- Added the restricted exact-handle owner-enrollment resolver; anonymous setup
  establishes tenant context without direct table access or an RLS bypass.
- Added separate owner and restricted runtime database roles; the runtime role
  cannot bypass RLS, alter the schema, or update/delete audit history.
- Added release-blocking cross-tenant, privilege-escalation, session-replay,
  authentication, audit, migration, and retained-data security checks.

### Operations

- Added isolated public integration, security, migration-drift, runtime, and
  retained-volume gates with generated Compose project names, pinned test
  credentials, fail-closed override checks, signal-safe cleanup, and raw-command
  guards. The explicit 200,000-subscription volume gate uses the same isolation.
- Added pinned semantic OpenAPI compatibility checks for the immutable web and
  mobile supported-client baselines.
- Documented that repository tests never delete or mutate the default persistent
  development PostgreSQL volume.
- Documented all 21 committed migrations and restricted release/test cleanup to
  proven disposable Compose projects and volumes.
- Added the PostgreSQL 18 Compose stack with health-ordered migrations, a
  persistent named volume, and an unprivileged multi-stage production image.
- Added Docker-first verification, Compose/runtime contracts, production
  dependency audit, migration validation, and operations/recovery guidance.
- Pinned PostgreSQL 18.4 and Node.js 24.18.0 images by digest and added an
  explicitly isolated retained-volume migration gate.

### Known limitations

- Phone OTP and owner-enrollment delivery use the local development/test adapter.
  No production provider, delivery queue, or asynchronous worker is implemented.
