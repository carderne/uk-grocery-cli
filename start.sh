#!/usr/bin/env bash
set -euo pipefail

: "${GROC_EMAIL:?Set GROC_EMAIL to the supermarket account email before running start.sh}"
: "${GROC_PASSWORD:?Set GROC_PASSWORD to the supermarket account password before running start.sh}"

mkdir -p "$HOME/.sainsburys"

docker rm -f uk-grocery-api >/dev/null 2>&1 || true

docker run -d \
  --name uk-grocery-api \
  --restart unless-stopped \
  -p 0.0.0.0:7876:7876 \
  -e GROC_API_HOST=0.0.0.0 \
  -e GROC_API_PORT="${GROC_API_PORT:-7876}" \
  -e GROC_PROVIDER="${GROC_PROVIDER:-sainsburys}" \
  -e GROC_EMAIL \
  -e GROC_PASSWORD \
  ${GROC_API_TOKEN:+-e GROC_API_TOKEN} \
  ${SAINSBURYS_STORE_NUMBER:+-e SAINSBURYS_STORE_NUMBER} \
  -v "$HOME/.sainsburys:/root/.sainsburys" \
  uk-grocery-api
