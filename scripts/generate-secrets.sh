#!/usr/bin/env bash
# Generates the random secrets of a self-hosted Scalo instance.
#
#   ./scripts/generate-secrets.sh                 print JWT_SECRET, ENCRYPTION_KEY and POSTGRES_PASSWORD (nothing is written)
#   ./scripts/generate-secrets.sh --write [file]  write them to .env (created from .env.example if missing)
#
# --write never replaces a secret that is already set: changing JWT_SECRET signs everybody out, changing
# ENCRYPTION_KEY makes the stored API / Stripe keys unreadable, and changing POSTGRES_PASSWORD after the database
# volume has been created locks the application out of its database.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rand_hex() { # $1 = number of random bytes
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

current() { # $1 = file, $2 = variable → its value ('' if unset or commented out)
  { grep -E "^$2=" "$1" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2-
}

set_var() { # $1 = file, $2 = variable, $3 = value
  local tmp
  tmp="$(mktemp)"
  { grep -vE "^$2=" "$1" || true; } >"$tmp"
  printf '%s=%s\n' "$2" "$3" >>"$tmp"
  cat "$tmp" >"$1"
  rm -f "$tmp"
}

is_placeholder() {
  case "$1" in '' | change-me | dev-secret-change-me | changeme) return 0 ;; *) return 1 ;; esac
}

case "${1:-}" in
  '')
    echo "JWT_SECRET=$(rand_hex 48)"
    echo "ENCRYPTION_KEY=$(rand_hex 32)"
    echo "POSTGRES_PASSWORD=$(rand_hex 24)"
    ;;
  --write)
    file="${2:-$root/.env}"
    if [ ! -f "$file" ]; then
      cp "$root/.env.example" "$file"
      echo "created $file from .env.example"
    fi
    chmod 600 "$file"
    fresh=no
    if is_placeholder "$(current "$file" JWT_SECRET)"; then
      set_var "$file" JWT_SECRET "$(rand_hex 48)"
      fresh=yes
      echo "JWT_SECRET         generated"
    else
      echo "JWT_SECRET         already set, kept"
    fi
    if [ -n "$(current "$file" ENCRYPTION_KEY)" ]; then
      echo "ENCRYPTION_KEY     already set, kept"
    elif [ "$fresh" = yes ]; then
      set_var "$file" ENCRYPTION_KEY "$(rand_hex 32)"
      echo "ENCRYPTION_KEY     generated"
    else
      echo "ENCRYPTION_KEY     not set: stored secrets are encrypted with a key derived from the existing JWT_SECRET, left as is"
    fi
    if is_placeholder "$(current "$file" POSTGRES_PASSWORD)"; then
      set_var "$file" POSTGRES_PASSWORD "$(rand_hex 24)"
      echo "POSTGRES_PASSWORD  generated"
    else
      echo "POSTGRES_PASSWORD  already set, kept"
    fi
    if [ -z "$(current "$file" SCALO_DOMAIN)" ]; then
      echo "Next: set SCALO_DOMAIN in $file (example: SCALO_DOMAIN=app.example.com), then"
      echo "      docker compose -f docker-compose.prod.yml up -d"
    fi
    ;;
  *)
    sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
