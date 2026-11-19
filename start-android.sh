#!/bin/sh
set -eu

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 ||
   ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  printf '%s\n' 'Node.js 22 or newer is required. In Termux, run: pkg install nodejs-lts' >&2
  exit 1
fi

export HOST=127.0.0.1
export PORT="${PORT:-4173}"
export HISTORY_CACHE_FILE="${HISTORY_CACHE_FILE:-$HOME/.cache/sofuse-tracker/sofuse-history.json}"

printf 'Open http://127.0.0.1:%s/ on this phone once the tracker is listening.\n' "$PORT"
printf '%s\n' 'Keep this Termux session running. Press Ctrl+C to stop the tracker.'
exec node server.mjs
