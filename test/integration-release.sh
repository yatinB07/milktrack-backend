#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_PREFIX='milktrack-integration'
. "$SCRIPT_DIR/isolated-compose.sh"

isolated_preflight
isolated_install_traps

isolated_compose build migrate integration
isolated_compose up -d --wait --wait-timeout 120 postgres
isolated_compose run --rm migrate
isolated_compose run --rm --env ISOLATED_DB_TEST=1 \
  integration npm run test:integration:raw
