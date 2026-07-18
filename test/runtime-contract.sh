#!/bin/sh
set -eu

production_image="${1:-milktrack-backend:production}"

docker run --rm --entrypoint node "$production_image" --input-type=module --eval '
  import { existsSync } from "node:fs";

  if (process.getuid() === 0) {
    throw new Error("production image must not run as root");
  }

  for (const modulePath of ["prisma", "@prisma/dev", "@hono/node-server"]) {
    if (existsSync(`/app/node_modules/${modulePath}`)) {
      throw new Error(`production image must omit ${modulePath}`);
    }
  }

  for (const modulePath of ["@prisma/client", "@prisma/adapter-pg", "pg"]) {
    if (!existsSync(`/app/node_modules/${modulePath}`)) {
      throw new Error(`production image must include ${modulePath}`);
    }
  }
'
echo 'production image contract: passed'

role_flags="$(
  docker compose exec -T postgres psql \
    --username milktrack_owner \
    --dbname milktrack \
    --tuples-only \
    --no-align \
    --command "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'milktrack_app';"
)"

if [ "$role_flags" != 't|f|f|f|f|f' ]; then
  echo "runtime role flags: expected t|f|f|f|f|f, got $role_flags" >&2
  exit 1
fi
echo 'runtime role flags: passed'

privileges="$(
  docker compose exec -T postgres psql \
    --username milktrack_owner \
    --dbname milktrack \
    --tuples-only \
    --no-align \
    --command "SELECT has_database_privilege('milktrack_app', 'milktrack', 'CONNECT'), has_database_privilege('milktrack_app', 'milktrack', 'TEMPORARY'), has_schema_privilege('milktrack_app', 'public', 'USAGE'), has_schema_privilege('milktrack_app', 'public', 'CREATE');"
)"

if [ "$privileges" != 't|f|t|f' ]; then
  echo "runtime privileges: expected t|f|t|f, got $privileges" >&2
  exit 1
fi
echo 'runtime privileges: passed'
