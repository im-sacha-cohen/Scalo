#!/usr/bin/env bash
# Backup of a self-hosted Scalo instance (docker-compose.prod.yml): database dump + uploaded files.
#
#   ./scripts/backup.sh [destination-directory]      default: ./backups
#
# Creates <destination>/scalo-<UTC date>/ with
#   db.dump          pg_dump, custom format (restore with pg_restore / scripts/restore.sh)
#   uploads.tar.gz   media library and lesson files (UPLOAD_DIR)
# The instance keeps running. Also keep a copy of your .env in a safe place: without JWT_SECRET / ENCRYPTION_KEY the
# API and Stripe keys stored in the database cannot be decrypted.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# standard Compose variables select another file / project: COMPOSE_FILE, COMPOSE_PROJECT_NAME, COMPOSE_ENV_FILES
export COMPOSE_FILE="${COMPOSE_FILE:-$root/docker-compose.prod.yml}"
compose=(docker compose)
dest="${1:-$root/backups}/scalo-$(date -u +%Y%m%d-%H%M%S)"

cd "$root"
umask 077 # the dump contains every contact: readable by the current user only
mkdir -p "$dest"
chmod 700 "$dest"

echo "[backup] database → $dest/db.dump"
"${compose[@]}" exec -T db pg_dump -U scalo -d scalo --format=custom --no-owner >"$dest/db.dump"

echo "[backup] uploads  → $dest/uploads.tar.gz"
"${compose[@]}" exec -T app tar -C /data -czf - uploads >"$dest/uploads.tar.gz"

# a truncated dump must not look like a backup
"${compose[@]}" exec -T db pg_restore --list <"$dest/db.dump" >/dev/null
gzip -t "$dest/uploads.tar.gz"

echo "[backup] done: $dest ($(du -sh "$dest" | cut -f1))"
