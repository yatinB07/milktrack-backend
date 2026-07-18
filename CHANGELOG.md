# Changelog

All notable backend changes are recorded here.

## [Unreleased]

### Added

- Added the production backend bootstrap, global DTO validation, stable error
  envelope, request correlation context, and versioned health contract.
- Added phone OTP and administrator password/TOTP MFA sign-in, opaque access and
  rotating refresh sessions, logout, logout-all, and authenticated actor APIs.
- Added separate platform and vendor roles, multi-role vendor memberships,
  scoped support authorization, and fail-closed security-denial auditing.
- Added platform vendor creation, cursor-paginated reads, optimistic lifecycle
  transitions, membership lifecycle, user delete/restore, and tenant audit APIs.
- Added selective soft deletion for Phase 1 master records and append-only audit
  history for privileged and security-sensitive changes.
- Added the idempotent development/test security seed for a platform
  administrator, Product Owner, and two isolated test vendors.
- Added the versioned deterministic OpenAPI artifact and contract drift check.

### Security

- Added forced PostgreSQL row-level security for vendor memberships, support
  grants, and audit events using transaction-local tenant context.
- Added separate owner and restricted runtime database roles; the runtime role
  cannot bypass RLS, alter the schema, or update/delete audit history.
- Added release-blocking cross-tenant, privilege-escalation, session-replay,
  authentication, audit, migration, and retained-data security checks.

### Operations

- Added the PostgreSQL 18 Compose stack with health-ordered migrations, a
  persistent named volume, and an unprivileged multi-stage production image.
- Added Docker-first verification, Compose/runtime contracts, production
  dependency audit, migration validation, and operations/recovery guidance.
