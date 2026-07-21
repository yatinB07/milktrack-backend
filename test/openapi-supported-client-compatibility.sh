#!/bin/sh
set -eu

IMAGE='tufin/oasdiff:v1.23.0@sha256:47c5709a744083d278df45cf24643b6fe30d98bde2a40a929cb512fbca6a0cc0'
WEB_HASH='f8042b34f7b3bfee66e64262c5aa63e5b4f5022876b975bbf272d410bd3c37ce'
MOBILE_HASH='97b29edd4b21ce88c7fb1d33d6ca0f24d9040323f5b1b3366d3878c4e8d6faa1'

cd "$(dirname "$0")/.."
command -v docker >/dev/null
test -f openapi/v1.json

printf '%s  %s\n%s  %s\n' \
  "$WEB_HASH" openapi/supported-clients/web-phase1.json \
  "$MOBILE_HASH" openapi/supported-clients/mobile-phase1.json \
  | sha256sum --check --strict -

docker run --rm --network none --volume "$PWD/openapi:/specs:ro" "$IMAGE" \
  breaking --fail-on ERR /specs/supported-clients/web-phase1.json /specs/v1.json
docker run --rm --network none --volume "$PWD/openapi:/specs:ro" "$IMAGE" \
  breaking --fail-on ERR /specs/supported-clients/mobile-phase1.json /specs/v1.json
