# MilkTrack backend

The backend is a NestJS modular monolith. It owns the HTTP API, business
rules, PostgreSQL access, Prisma migrations, and the generated OpenAPI
contract. It runs on Node.js 24, strict TypeScript, Prisma 7, and PostgreSQL
18.

## Local development

Docker is the only server-side prerequisite. Node.js and PostgreSQL do not
need to be installed on the host.

```bash
cp .env.example .env
docker compose --env-file .env up --build --wait
```

The API is available at `http://localhost:3000/v1/health` and its OpenAPI
document is available at `http://localhost:3000/openapi.json`.

The Compose project starts `postgres`, waits for its health check, runs the
one-shot `migrate` service, then starts `backend`. PostgreSQL data is stored
in the named `postgres_data` volume. `docker compose down` preserves that
data; use `docker compose down -v` only when intentionally deleting the
local database.

Useful checks:

```bash
docker compose --env-file .env run --rm backend npm run verify
docker compose --env-file .env run --rm backend npm run db:validate
bash test/compose-contract.sh
```

The production image can be built and inspected with:

```bash
docker build --target production -t milktrack-backend:production .
bash test/runtime-contract.sh milktrack-backend:production
docker run --rm --entrypoint npm milktrack-backend:production audit --omit=dev --omit=optional
```

Never commit `.env` or real credentials. The values in `.env.example` are
local placeholders only.

## Repository workflow

Use one independently testable feature or bug fix per work unit. Follow
RED, GREEN, REFACTOR, run the affected checks, and commit before starting the
next work unit. Controllers use DTOs and explicit response mapping; Prisma
records are not returned directly from HTTP handlers.
