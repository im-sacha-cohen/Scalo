#!/bin/sh
# Scalo — container entry point. Only PUBLIC_URL is required, everything else has a working default:
#   - JWT_SECRET unset: generated once and kept in /data/secrets.env
#   - DATABASE_URL unset: PostgreSQL runs inside this container, data in /data/postgres, a daily dump in /data/backups
# /data must be a persistent volume, otherwise the database and the secrets are lost when the container is recreated.
set -eu

SECRETS=/data/secrets.env
PGDATA=/data/postgres
BACKUPS=/data/backups
umask 077

if [ -z "${PUBLIC_URL:-}" ]; then
  echo '[scalo] PUBLIC_URL est requis (ex. https://app.exemple.fr) : un autre nom de domaine recevrait une page 404.' >&2
  exit 1
fi

# Value of a generated secret: the stored one, or a new one written to the secrets file.
generated() {
  value=$(sed -n "s/^$1=//p" "$SECRETS" 2>/dev/null || true)
  if [ -z "$value" ]; then
    value=$(node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('hex'))")
    printf '%s=%s\n' "$1" "$value" >>"$SECRETS"
  fi
  printf '%s' "$value"
}

if [ -z "${JWT_SECRET:-}" ]; then
  JWT_SECRET=$(generated JWT_SECRET)
  export JWT_SECRET
fi

# External database (docker-compose.prod.yml, hosted PostgreSQL): nothing else to do here.
if [ -n "${DATABASE_URL:-}" ]; then
  exec "$@"
fi

PGPASSWORD=$(generated POSTGRES_PASSWORD)
PGHOST=127.0.0.1
PGUSER=scalo
export PGPASSWORD PGHOST PGUSER
export DATABASE_URL="postgres://$PGUSER:$PGPASSWORD@$PGHOST:5432/scalo"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  pwfile=$(mktemp)
  printf '%s' "$PGPASSWORD" >"$pwfile"
  initdb -D "$PGDATA" -U "$PGUSER" --pwfile="$pwfile" --auth=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8 >/dev/null
  rm -f "$pwfile"
fi
pg_ctl -D "$PGDATA" -w -t 120 start -o "-c listen_addresses=127.0.0.1 -c unix_socket_directories=''" >/dev/null
psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'scalo'" | grep -q 1 || createdb scalo

# One dump per day, kept 7 days. The check is hourly so that frequent redeployments cannot postpone it forever.
daily_backups() {
  mkdir -p "$BACKUPS"
  while sleep 3600; do
    dump="$BACKUPS/scalo-$(date -u +%Y%m%d).dump"
    [ -e "$dump" ] && continue
    if pg_dump -d scalo --format=custom --no-owner -f "$dump.tmp"; then
      mv "$dump.tmp" "$dump"
    else
      rm -f "$dump.tmp"
    fi
    find "$BACKUPS" -name 'scalo-*.dump' -mtime +7 -delete || true
  done
}
daily_backups &
backups=$!

"$@" &
app=$!
trap 'kill -TERM "$app" 2>/dev/null || true' TERM INT

# `wait` returns early when a signal is trapped: keep waiting until the application has really stopped.
status=0
while kill -0 "$app" 2>/dev/null; do
  status=0
  wait "$app" || status=$?
done

kill "$backups" 2>/dev/null || true
pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null || true
exit "$status"
