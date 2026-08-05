#!/bin/sh
# A local Postgres for the harnesses, in a container that has no Docker.
#
# ─────────────────────────────────────────────────────────────────────────────
# Why this exists
# ─────────────────────────────────────────────────────────────────────────────
#
# Two days of work went out unexecuted on the conclusion that this container had no
# Postgres. It has one: /usr/lib/postgresql/16/bin/postgres. `initdb` exits 1 when run as
# root — "cannot be run as root", with the fix in its own hint — and that refusal was read
# as an absence. See CLAUDE.md on absence claims from a single failing command.
#
# So this is committed rather than kept in a scratch directory: the next session should
# find it before repeating the diagnosis.
#
#   ./scripts/pg-scratch.sh up      start (idempotent) — safe to run before any harness
#   ./scripts/pg-scratch.sh init    create the cluster, database, migrations and seed
#
# The cluster dies without logging a shutdown when the container reclaims memory, so `up`
# is idempotent on purpose and worth running before a suite rather than diagnosing
# "connection refused" again.
#
# DATABASE_URL=postgresql://postgres@127.0.0.1:55432/kiln

set -e
PGBIN=/usr/lib/postgresql/16/bin
PGDATA=/home/pgrunner/pgdata
PORT=55432
URL="postgresql://postgres@127.0.0.1:$PORT/kiln"

up() {
  pg_isready -h 127.0.0.1 -p $PORT >/dev/null 2>&1 && return 0
  su pgrunner -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PORT -k /tmp' -l /home/pgrunner/pg.log start" >/dev/null 2>&1 || true
  i=0
  while [ $i -lt 20 ]; do
    pg_isready -h 127.0.0.1 -p $PORT >/dev/null 2>&1 && return 0
    sleep 1; i=$((i + 1))
  done
  echo "cluster did not come up; see /home/pgrunner/pg.log" >&2
  return 1
}

case "${1:-up}" in
  up) up; echo "$URL" ;;
  init)
    id pgrunner >/dev/null 2>&1 || useradd -m pgrunner
    su pgrunner -c "rm -rf $PGDATA && $PGBIN/initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
    up
    psql "postgresql://postgres@127.0.0.1:$PORT/postgres" -c "create database kiln" >/dev/null
    pnpm db:push "$URL" >/dev/null
    psql "$URL" -v ON_ERROR_STOP=1 -q -f supabase/seed.sql >/dev/null
    echo "$URL"
    ;;
  *) echo "usage: $0 [up|init]" >&2; exit 2 ;;
esac
