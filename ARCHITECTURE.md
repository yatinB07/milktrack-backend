# Backend architecture

MilkTrack is one deployable NestJS modular monolith backed by one shared
PostgreSQL database. Module boundaries keep capabilities separable without
introducing distributed transactions, brokers, or speculative services.

## Request and dependency flow

```text
HTTP controller -> request DTO and validation -> application operation
                                                -> domain rule
                                                -> Prisma adapter
                                                -> response DTO

Feature module -> authorization / audit / identity application contracts
               -> database transaction boundary
```

Controllers map transport DTOs and stay free of business rules. Application
operations coordinate authorization, transactions, audit, and domain behavior.
Domain code owns state transitions and security invariants. Prisma types and
records stay inside infrastructure code and never form a public API contract.

Dependencies point from feature modules toward the small identity,
authorization, audit, and database foundations. A module calls another module's
exported application operation rather than importing its persistence adapter.
The current implementation has no message broker, outbox, cache, or remote
service boundary.

## Phase 1 modules and table ownership

| Module | Responsibility | Owned tables |
|---|---|---|
| Identity | Phone OTP, administrator password/TOTP MFA, opaque sessions, actor resolution, and user lifecycle | `users`, `user_identities`, `password_credentials`, `mfa_factors`, `pending_mfa_authentications`, `otp_challenges`, `sessions` |
| Vendors | Platform vendor creation, reads, and audited lifecycle transitions | `vendors` |
| Memberships | Vendor role membership lifecycle and role changes | `vendor_memberships` |
| Authorization | Platform-role and support-grant policy evaluation | `platform_role_assignments`, `support_access_grants` |
| Audit | Append-only privileged/security events and tenant audit reads | `audit_events` |
| Database | Prisma connection and tenant-scoped transaction runner | No business tables |
| Health | Liveness HTTP contract | No tables |

Some authorization tables currently have schema and policy consumers but no
public management endpoint. Their presence does not imply that later platform
plan, dashboard, billing, or support-administration features are implemented.

## Authentication and session storage

Customers and agents authenticate through a phone OTP challenge. Vendor and
platform administrators use email/password followed by TOTP MFA. Passwords use
`scrypt`; TOTP secrets are encrypted with the injected MFA key. OTP challenge
tokens, codes, destinations, access tokens, refresh tokens, IP addresses, and
pending-MFA tokens are stored only as hashes where they are used for lookup or
verification. Session rows bind the authentication method, device, expiry,
rotation predecessor, and revocation state.

Browser refresh tokens use a secure, HTTP-only, same-site cookie scoped to
`/v1/auth`; mobile clients return refresh tokens in the request body and are
responsible for device-secure storage. Access tokens are opaque bearer tokens.
Refresh rotates the session; detected replay revokes every active session for
the user. Logout and logout-all record revocation rather than deleting session
history.

The local OTP adapter exists only for development/test and logs the code with a
masked destination. Production requires a real provider adapter; no provider
credentials are committed.

## Tenant and authorization boundary

Vendor-scoped operations follow one sequence:

```text
authenticate opaque session
  -> build Actor from active user, platform roles, and active memberships
  -> validate vendor UUID
  -> begin short PostgreSQL transaction
  -> SET LOCAL app.vendor_id through set_config(..., true)
  -> authorize role or active, scoped support grant
  -> read or mutate tenant rows
  -> append required audit event in the same transaction
  -> commit
```

`vendor_memberships`, `support_access_grants`, and `audit_events` have row-level
security enabled and forced. Their policies compare `vendor_id` with the
transaction-local `app.vendor_id`. The API connects as `milktrack_app`, which is
neither the table owner nor a superuser and has no `BYPASSRLS`, schema-create,
database-create, or role-create privilege. PostgreSQL therefore remains a
defense-in-depth boundary even if application query filtering is missed.

RLS does not replace authorization: the application still checks the actor's
role, authentication assurance, operation, and support-grant scope. Product
Owners receive only permitted non-sensitive platform vendor data. Support access
requires an active, unexpired, read-only scoped grant and records the successful
access in the same transaction. A denied access attempt is audited; if that
security audit cannot be written, the request fails closed.

The database owner URL belongs only to migrations, controlled tests, and direct
administration. Compose exposes it to integration tests only through
`TEST_OWNER_DATABASE_URL`; the backend service never receives it. Supplying
owner credentials to the API would bypass this threat boundary and is
release-blocking.

## Soft deletion and immutable history

Selective soft deletion applies to mutable master records only:

- `users`, `vendors`, and `vendor_memberships` carry `deleted_at`, `deleted_by`,
  and `deletion_reason`;
- normal reads explicitly exclude deleted rows;
- membership and user restore operations are explicit, authorized, and audited;
- closing a vendor is a lifecycle transition and does not erase its history;
- active-only uniqueness uses partial indexes where identifiers may be reused.

There is no global Prisma soft-delete middleware. Authentication challenges and
sessions are consumed, expired, or revoked. Audit events are never soft-deleted:
the runtime role receives only `SELECT` and `INSERT`, RLS limits reads/inserts,
and PostgreSQL revokes `UPDATE` and `DELETE`. Historical audit foreign keys use
restricted updates/deletes so a vendor identity cannot rewrite its audit trail.

## Audit ordering and pagination

Privileged state changes and their audit events execute in the same database
transaction; failure of the required audit write rolls back the state change.
Authentication and security-denial events use their own appropriate transaction,
with anonymous audit rows limited by a database constraint to issued OTP
challenges. Request correlation IDs connect HTTP activity to audit records, and
IP values are HMAC-protected before storage.

Vendor and audit lists use opaque bounded cursors: default 25, maximum 100, with
a stable ID tie-breaker. Their ordered timestamps use PostgreSQL millisecond
precision to match JavaScript cursor serialization.

## PostgreSQL and migration topology

```text
postgres + named postgres_data volume
  -> health check
  -> one-shot migrate service with owner credential
  -> backend with restricted runtime credential
```

The database port is not published. Locally, PostgreSQL data survives normal
container lifecycle operations in `postgres_data`. Staging and production must
use durable private storage, automated encrypted backups, tested restoration,
monitoring, and separate migration/runtime credentials. Committed migrations are
append-only operational history; corrections use a new forward migration.

## OpenAPI boundary

All application API routes start at `/v1`; Swagger UI and JSON are served at
`/openapi` and `/openapi.json`. Nest class DTOs validate structured input with
transformation, whitelisting, and unknown-field rejection; explicit response
DTOs prevent Prisma or credential fields from leaking. The runtime Swagger
document and committed `openapi/v1.json` come from the same application
configuration. CI regenerates the deterministic artifact and fails on drift.
Backend contract changes are committed and released before dependent client
repositories regenerate their types.

## Future extraction

Extraction is considered only after a measured independent scaling,
reliability, security, ownership, or deployment need. The sequence is:

1. identify one module boundary and freeze a backward-compatible versioned
   application/API contract;
2. make all callers use that owning contract and remove cross-table access;
3. move the module's data and operations behind a separately deployed service;
4. add transactional outbox/inbox and idempotent consumers for communication
   that is no longer covered by the local ACID transaction;
5. move traffic incrementally, observe and reconcile both sides, then retire the
   in-process path.

No microservice, broker, distributed transaction, or extraction-only abstraction
exists today. This keeps the present system simple while preserving a practical
strangler path if operating evidence justifies it.
