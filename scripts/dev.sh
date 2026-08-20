#!/usr/bin/env bash
# One-command local development: migrations + seed + API + worker (tsx watch).
# Requires DATABASE_URL to point at a local Postgres (see README for a
# one-liner ephemeral cluster) and the usual .env exports.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Start a Postgres and export DATABASE_URL first." >&2
  exit 1
fi

npm run dev:migrate
npm run seed

trap 'kill 0' EXIT
npx tsx watch src/api/main.ts &
npx tsx watch src/worker/main.ts &
wait
