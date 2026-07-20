# Changelog

All notable backend changes are recorded here.

## [Unreleased]

### Added

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

- Added the PostgreSQL 18 Compose stack with health-ordered migrations, a
  persistent named volume, and an unprivileged multi-stage production image.
- Added Docker-first verification, Compose/runtime contracts, production
  dependency audit, migration validation, and operations/recovery guidance.
- Pinned PostgreSQL 18.4 and Node.js 24.18.0 images by digest and added an
  explicitly isolated retained-volume migration gate.

### Known limitations

- Phone OTP and owner-enrollment delivery use the local development/test adapter.
  No production provider, delivery queue, or asynchronous worker is implemented.
