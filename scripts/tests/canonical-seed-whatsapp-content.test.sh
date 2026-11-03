#!/usr/bin/env bash
# Owning-boundary tests for scripts/validate-canonical-seed-dump.sh.
#
# Size cannot distinguish a good whatsapp-v2 -Fc archive from a poisoned
# cold-sync (~30MiB both). This suite locks the row-content gate that does.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
VALIDATE="$ROOT_DIR/scripts/validate-canonical-seed-dump.sh"
PASS=0
FAIL=0

assert_exit() {
  local label="$1" expected="$2"
  shift 2
  set +e
  "$@" >/tmp/validate-canonical-seed-test.out 2>/tmp/validate-canonical-seed-test.err
  local got=$?
  set -e
  if [ "$got" -eq "$expected" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ $label"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $label (expected exit $expected, got $got)"
    echo "     stdout: $(cat /tmp/validate-canonical-seed-test.out)"
    echo "     stderr: $(cat /tmp/validate-canonical-seed-test.err)"
  fi
}

if [ ! -x "$VALIDATE" ]; then
  echo "FAIL: validate script missing or not executable: $VALIDATE"
  exit 1
fi

# Usage / missing DB name
assert_exit "usage fails closed without database name" 2 bash "$VALIDATE"

# Live probes created during the whatsapp-history-recall RCA (optional — skip
# when this VM has not restored them). When present they are the exact RED/GREEN
# pair: poisoned R2 restore vs republished fixture.
export PGPASSWORD="${PGPASSWORD:-postgres}"
if psql -h localhost -U postgres -d victoria_rca_probe -c 'SELECT 1' >/dev/null 2>&1; then
  assert_exit "poisoned restore (0 WHATSAPP rows) fails" 1 \
    bash "$VALIDATE" victoria_rca_probe
else
  echo "  ⏭ skip poisoned-probe live check (victoria_rca_probe absent)"
fi

if psql -h localhost -U postgres -d victoria_fixed_probe -c 'SELECT 1' >/dev/null 2>&1; then
  assert_exit "fixed restore (3825 WHATSAPP rows + CONNECTED) passes" 0 \
    bash "$VALIDATE" victoria_fixed_probe
else
  echo "  ⏭ skip fixed-probe live check (victoria_fixed_probe absent)"
fi

# Hermetic row-content fixture in a private database on the local Postgres used
# by the backend blackbox suites. The whatsapp-v2 revision also promises the
# archived agent trajectories that the grep-agent-trajectories-* catalog tasks
# recall (context_notes: "materialized in the canonical base image search
# index"). PG15 publications carried WhatsApp rows but an EMPTY
# AgentTrajectorySearch table, and every cloud guest restored them because the
# validator only checked WhatsApp. A fixture missing either row set must fail.
# Private throwaway cluster on a unix socket: no running stack DB, port, or
# workspace variable is required, and no shared database is touched.
PG_BINDIR="$(pg_config --bindir 2>/dev/null || true)"
INITDB="$(command -v initdb || true)"
[ -n "$INITDB" ] || INITDB="${PG_BINDIR:+$PG_BINDIR/initdb}"
PG_CTL="$(command -v pg_ctl || true)"
[ -n "$PG_CTL" ] || PG_CTL="${PG_BINDIR:+$PG_BINDIR/pg_ctl}"
if [ ! -x "${INITDB:-}" ] || [ ! -x "${PG_CTL:-}" ]; then
  echo "FAIL: canonical content fixture needs PostgreSQL server binaries (initdb, pg_ctl)"
  echo "      on PATH or under \$(pg_config --bindir); install the local Postgres server package."
  exit 1
fi
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/canonical-seed-pg.XXXXXX")"
FIXTURE_PG_HOST="$FIXTURE_ROOT"
FIXTURE_PG_PORT=55432
FIXTURE_DB="canonical_seed_content_test"
stop_fixture_cluster() {
  "$PG_CTL" -D "$FIXTURE_ROOT/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$FIXTURE_ROOT"
}
trap stop_fixture_cluster EXIT
"$INITDB" -D "$FIXTURE_ROOT/data" -U postgres --auth=trust -E UTF8 >"$FIXTURE_ROOT/initdb.log" 2>&1
if ! "$PG_CTL" -D "$FIXTURE_ROOT/data" -l "$FIXTURE_ROOT/server.log" -w -t 60 \
  -o "-k $FIXTURE_ROOT -p $FIXTURE_PG_PORT -c listen_addresses=''" start >/dev/null; then
  echo "FAIL: throwaway Postgres for the canonical content fixture did not start"
  cat "$FIXTURE_ROOT/server.log"
  exit 1
fi
fixture_psql() {
  psql -h "$FIXTURE_PG_HOST" -p "$FIXTURE_PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@" >/dev/null
}
fixture_psql -d postgres -c "CREATE DATABASE \"$FIXTURE_DB\""
fixture_psql -d "$FIXTURE_DB" <<'SQL'
CREATE TABLE "Person" (id TEXT PRIMARY KEY, "userId" TEXT NOT NULL);
CREATE TABLE "MessageRecord" (id TEXT PRIMARY KEY, "personId" TEXT NOT NULL, channel TEXT NOT NULL);
CREATE TABLE "Integration" ("userId" TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE "User" ("userId" TEXT PRIMARY KEY, name TEXT, email TEXT, "addressLine1" TEXT);
CREATE TABLE "AgentTrajectorySearch" (
  "messageId" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "rootAgentId" TEXT NOT NULL,
  role TEXT NOT NULL, "archivePath" TEXT
);
INSERT INTO "Person" VALUES ('p1', '1f85ff25-6e29-4c1b-8739-f917bd101a30');
INSERT INTO "MessageRecord" SELECT 'm' || g, 'p1', 'WHATSAPP' FROM generate_series(1, 3825) g;
INSERT INTO "Integration" VALUES ('1f85ff25-6e29-4c1b-8739-f917bd101a30', 'whatsapp', 'CONNECTED');
INSERT INTO "User" VALUES ('1f85ff25-6e29-4c1b-8739-f917bd101a30', 'Andy Prevalsky', 'andy@fixture.test', '1 Fixture Street');
SQL
assert_exit "WhatsApp rows with an empty trajectory archive (PG15 publication) fail" 1 \
  bash "$VALIDATE" "$FIXTURE_DB" "$FIXTURE_PG_HOST" "$FIXTURE_PG_PORT"
# Live (non-archive) rows from runs on the restored stack do not satisfy the
# promise: only the archived prior runs exist on a fresh volume.
fixture_psql -d "$FIXTURE_DB" <<'SQL'
INSERT INTO "AgentTrajectorySearch"
SELECT 'live-' || r || '-' || g, '1f85ff25-6e29-4c1b-8739-f917bd101a30', r, 'USER', NULL
FROM generate_series(1, 200) g,
     unnest(ARRAY['ec19feb9-2b8a-4369-8c1b-886be79c8a8c',
                  'c4531f8e-ad45-41a0-84a1-eb6714b5c63b',
                  '18ad8b43-1363-43dd-a4df-278b80bc1b63']) r;
SQL
assert_exit "live-only trajectory rows do not satisfy the archived history" 1 \
  bash "$VALIDATE" "$FIXTURE_DB" "$FIXTURE_PG_HOST" "$FIXTURE_PG_PORT"
fixture_psql -d "$FIXTURE_DB" <<'SQL'
INSERT INTO "AgentTrajectorySearch"
SELECT r || '-' || g, '1f85ff25-6e29-4c1b-8739-f917bd101a30', r,
       CASE WHEN g = 1 THEN 'USER' ELSE 'TOOL' END, 'db/end.fixture.json.gz.enc'
FROM (VALUES ('ec19feb9-2b8a-4369-8c1b-886be79c8a8c', 42),
             ('c4531f8e-ad45-41a0-84a1-eb6714b5c63b', 21)) v(r, n),
     generate_series(1, v.n) g;
SQL
assert_exit "a missing archived root (city comparison run) still fails" 1 \
  bash "$VALIDATE" "$FIXTURE_DB" "$FIXTURE_PG_HOST" "$FIXTURE_PG_PORT"
fixture_psql -d "$FIXTURE_DB" <<'SQL'
INSERT INTO "AgentTrajectorySearch"
SELECT '18ad-' || g, '1f85ff25-6e29-4c1b-8739-f917bd101a30',
       '18ad8b43-1363-43dd-a4df-278b80bc1b63',
       CASE WHEN g = 1 THEN 'USER' ELSE 'TOOL' END, 'db/end.fixture.json.gz.enc'
FROM generate_series(1, 178) g;
SQL
assert_exit "reviewed WhatsApp rows + all archived trajectory roots pass" 0 \
  bash "$VALIDATE" "$FIXTURE_DB" "$FIXTURE_PG_HOST" "$FIXTURE_PG_PORT"
# The revision also promises the bench user's prod profile. The reviewed Aug-5
# fixture froze an older, blank prod User row (prod replaced it on 2026-09-01),
# so sign-up tasks had no name to type and asked a human who is not there
# (RCA 2026-10-23-canonical-bench-user-missing-profile-name-signup-handoff).
fixture_psql -d "$FIXTURE_DB" -c \
  "UPDATE \"User\" SET name = NULL, \"addressLine1\" = NULL WHERE \"userId\" = '1f85ff25-6e29-4c1b-8739-f917bd101a30'"
assert_exit "a blank bench-user profile (no name, no address) fails" 1 \
  bash "$VALIDATE" "$FIXTURE_DB" "$FIXTURE_PG_HOST" "$FIXTURE_PG_PORT"
fixture_psql -d "$FIXTURE_DB" -c \
  "UPDATE \"User\" SET name = '  ', \"addressLine1\" = '1 Fixture Street' WHERE \"userId\" = '1f85ff25-6e29-4c1b-8739-f917bd101a30'"
assert_exit "a whitespace-only bench-user name fails" 1 \
  bash "$VALIDATE" "$FIXTURE_DB" "$FIXTURE_PG_HOST" "$FIXTURE_PG_PORT"
fixture_psql -d "$FIXTURE_DB" -c \
  "UPDATE \"User\" SET name = 'Andy Prevalsky', \"addressLine1\" = NULL WHERE \"userId\" = '1f85ff25-6e29-4c1b-8739-f917bd101a30'"
assert_exit "a bench user without a delivery address line fails" 1 \
  bash "$VALIDATE" "$FIXTURE_DB" "$FIXTURE_PG_HOST" "$FIXTURE_PG_PORT"
fixture_psql -d "$FIXTURE_DB" -c \
  "UPDATE \"User\" SET \"addressLine1\" = '1 Fixture Street', email = NULL WHERE \"userId\" = '1f85ff25-6e29-4c1b-8739-f917bd101a30'"
assert_exit "a bench user without an email fails" 1 \
  bash "$VALIDATE" "$FIXTURE_DB" "$FIXTURE_PG_HOST" "$FIXTURE_PG_PORT"
fixture_psql -d "$FIXTURE_DB" -c \
  "UPDATE \"User\" SET email = 'andy@fixture.test' WHERE \"userId\" = '1f85ff25-6e29-4c1b-8739-f917bd101a30'"
assert_exit "named bench user with an email and address passes again" 0 \
  bash "$VALIDATE" "$FIXTURE_DB" "$FIXTURE_PG_HOST" "$FIXTURE_PG_PORT"
stop_fixture_cluster
trap - EXIT

# run.sh must call the validator after restore and before publish
if grep -q 'validate-canonical-seed-dump.sh' "$ROOT_DIR/scripts/run.sh" \
  && grep -q 'lacked reviewed WhatsApp history or archived agent trajectories' "$ROOT_DIR/scripts/run.sh" \
  && grep -q 'refusing to publish: DB failed canonical content check' "$ROOT_DIR/scripts/run.sh"; then
  PASS=$((PASS + 1))
  echo "  ✅ run.sh gates restore + publish on canonical content"
else
  FAIL=$((FAIL + 1))
  echo "  ❌ run.sh missing canonical content gates"
fi

echo
if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: $FAIL canonical-seed-content check(s) failed ($PASS passed)"
  exit 1
fi
echo "PASS: canonical seed content gate ($PASS checks)"
