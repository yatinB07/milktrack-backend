# Backend architecture

MilkTrack uses a modular monolith: one deployable NestJS application with
explicit module boundaries. This keeps local deployment simple while keeping
business capabilities separable as the product grows.

## Runtime boundaries

```text
HTTP controller -> request DTO / validation -> application use case
                                            -> domain rules
                                            -> infrastructure adapter (Prisma)
                                            -> response DTO
```

- Controllers stay thin and expose the versioned `/v1` API.
- Nest class DTOs define every structured public request and response. The
  global validation pipe transforms known values, whitelists fields, and
  rejects unknown fields.
- Application and domain code owns authorization, tenant enforcement, money,
  pricing, billing, idempotency, and delivery rules.
- Prisma is an infrastructure detail. Database records are mapped to domain
  or response types before crossing a boundary.
- PostgreSQL is the shared system of record. The migration runner uses the
  database owner; the API uses a separate login role without superuser,
  database-creation, role-creation, replication, or `BYPASSRLS` privileges.

## Local Compose topology

```text
postgres (named postgres_data volume)
       | healthy
       v
migrate (one shot, owner connection)
       | completed successfully
       v
backend (API, runtime connection)
```

The database port is intentionally not published by Compose. The API is
published on port 3000 for local clients. The named volume survives container
restart, recreation, host reboot, and `docker compose down`; deleting it is an
explicit destructive operation.

## Planned module boundaries

The current implementation contains only application bootstrap and health.
Business modules are added when their approved use cases are implemented:

- identity and access
- tenant/vendor administration
- customer and subscription management
- product and pricing
- delivery planning and execution
- billing and payments
- notifications and audit

Each module should expose application-level contracts to other modules and
keep persistence details inside its infrastructure adapter. Add abstractions
only when a second implementation or a real boundary requires them.
