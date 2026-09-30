#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh into a self-hosted Scalo instance (docker-compose.prod.yml).
#
#   ./scripts/restore.sh <backup-directory> [--yes]
#
# REPLACES the current database and the uploaded files with the content of the backup. The application is stopped
# during the operation and restarted at the end (pending migrations are applied at startup). Use the same
# JWT_SECRET / ENCRYPTION_KEY as the instance that made the backup.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# standard Compose variables select another file / project: COMPOSE_FILE, COMPOSE_PROJECT_NAME, COMPOSE_ENV_FILES
export COMPOSE_FILE="${COMPOSE_FILE:-$root/docker-compose.prod.yml}"
compose=(docker compose)

src="${1:-}"
if [ -z "$src" ] || [ ! -f "$src/db.dump" ]; then
  echo "usage: $0 <backup-directory> [--yes]   (the directory must contain db.dump)" >&2
  exit 2
fi
src="$(cd "$src" && pwd)"

if [ "${2:-}" != "--yes" ]; then
  printf 'This replaces the database and the uploads of the running instance with %s. Continue? [y/N] ' "$src"
  read -r answer
  case "$answer" in y | Y | yes | oui | o | O) ;; *) echo "aborted"; exit 1 ;; esac
fi

cd "$root"
"${compose[@]}" up -d --wait db
echo "[restore] stopping the application"
"${compose[@]}" stop app

echo "[restore] database ← $src/db.dump"
"${compose[@]}" exec -T db dropdb -U scalo --if-exists --force scalo
"${compose[@]}" exec -T db createdb -U scalo -O scalo scalo
"${compose[@]}" exec -T db pg_restore -U scalo -d scalo --no-owner --exit-on-error <"$src/db.dump"

if [ -f "$src/uploads.tar.gz" ]; then
  echo "[restore] uploads  ← $src/uploads.tar.gz"
  # one-off container on the uploads volume: empty it, then extract the archive
  "${compose[@]}" run --rm --no-deps -T --entrypoint sh app -c \
    'find /data/uploads -mindepth 1 -delete && tar -C /data -xzf -' <"$src/uploads.tar.gz"
else
  echo "[restore] no uploads.tar.gz in the backup: uploads left untouched"
fi

echo "[restore] starting the application"
"${compose[@]}" up -d --wait app
echo "[restore] done"
