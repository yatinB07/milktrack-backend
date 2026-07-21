#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_PREFIX='milktrack-p2-volume'
. "$SCRIPT_DIR/isolated-compose.sh"

if [ "${P2_VOLUME_GATE:-}" != 1 ]; then
  echo 'P2_VOLUME_GATE=1 is required' >&2
  exit 1
fi

isolated_preflight
isolated_install_traps

echo "volume gate project: $PROJECT"
isolated_compose build migrate integration
isolated_compose up -d postgres migrate
isolated_compose run --rm --env P2_VOLUME_GATE=1 integration \
  timeout 840 node --import tsx test/schedule-generation-volume.gate.ts
