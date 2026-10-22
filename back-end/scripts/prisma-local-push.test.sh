#!/usr/bin/env bash
set -euo pipefail

SCRIPT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prisma-local-push.sh
LOCAL_URL=postgresql://postgres:postgres@localhost:5432/test
REMOTE_URL=postgresql://postgres:postgres@db.example.com:5432/prod

if DATABASE_URL="$REMOTE_URL" DIRECT_URL="$LOCAL_URL" PRISMA_LOCAL_PUSH_DRY_RUN=1 \
  bash "$SCRIPT" >/dev/null 2>&1; then
  echo "DATABASE_URL remote-target guard failed" >&2
  exit 1
fi

if DATABASE_URL="$LOCAL_URL" DIRECT_URL="$REMOTE_URL" PRISMA_LOCAL_PUSH_DRY_RUN=1 \
  bash "$SCRIPT" >/dev/null 2>&1; then
  echo "DIRECT_URL remote-target guard failed" >&2
  exit 1
fi

DATABASE_URL="$LOCAL_URL" DIRECT_URL="$LOCAL_URL" PRISMA_LOCAL_PUSH_DRY_RUN=1 \
  bash "$SCRIPT" | grep -Fq 'validation passed'

# Agents follow these docs literally. A bare `npx prisma db push` from back-end/
# picks up back-end/.env's prod URLs and drops every index Prisma cannot model,
# so instructions must route local pushes through the guarded wrapper instead.
# Scan a single workspace's active instructions; reusable for isolated fixtures.
assert_safe_instruction_docs() {
  local root=$1
  python3 - "$root" <<'PYSCAN'
import os
from pathlib import Path
import re
import shlex
import sys
from urllib.parse import urlsplit

root = Path(sys.argv[1])
paths = [root / "CLAUDE.md", root / "AGENTS.md"]
for directory in (".claude", "docs"):
    for parent, directories, files in os.walk(root / directory):
        if Path(parent) == root / ".claude":
            directories[:] = [name for name in directories if name != "worktrees"]
        if Path(parent) == root / "docs":
            directories[:] = [name for name in directories if name not in ("rca", "plans")]
        paths.extend(Path(parent) / name for name in files if name.endswith(".md"))

push = re.compile(r"\bnpx(?:\s+--no-install)?\s+prisma\s+db\s+push\b")
assignment = re.compile(r"[A-Za-z_][A-Za-z_0-9]*=")

def local_url(value):
    try:
        parsed = urlsplit(value)
        return parsed.scheme in ("postgres", "postgresql") and parsed.hostname in ("localhost", "127.0.0.1")
    except ValueError:
        return False

def scoped(command):
    # Only an outer inline-code pair is Markdown; interior shell substitutions
    # execute before command-scoped assignments and cannot prove local scope.
    command = command.strip()
    if command.startswith("`") and command.endswith("`"):
        command = command[1:-1]
    if "`" in command or "$(" in command:
        return False
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()")
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return False
    positions = []
    for i, token in enumerate(tokens):
        offset = 2 if tokens[i:i + 2] == ["npx", "--no-install"] else 1
        if token == "npx" and tokens[i + offset:i + offset + 3] == ["prisma", "db", "push"]:
            positions.append(i)
    if len(positions) != len(push.findall(command)):
        return False
    for i in positions:
        start = max((j + 1 for j in range(i) if tokens[j] and all(c in ";&|()" for c in tokens[j])), default=0)
        prefix = tokens[start:i]
        if prefix[:1] == ["env"]:
            prefix = prefix[1:]
        if any(not assignment.match(token) for token in prefix):
            return False
        values = dict(token.split("=", 1) for token in prefix)
        if not all(local_url(values.get(name, "")) for name in ("DATABASE_URL", "DIRECT_URL")):
            return False
    return True

unsafe = False
for path in sorted(paths):
    if not path.is_file():
        continue
    command = ""
    for number, line in enumerate(path.read_text().splitlines(), 1):
        command += line
        if command.rstrip().endswith("\\"):
            command = command.rstrip()[:-1] + " "
            continue
        if push.search(command) and not scoped(command):
            print(f"{path.relative_to(root)}:{number}: {line}", file=sys.stderr)
            unsafe = True
        command = ""
if unsafe:
    print("instruction docs tell agents to run a bare prisma db push; use npm run prisma:push:local", file=sys.stderr)
    sys.exit(1)
PYSCAN
}

# Exercise discovery and rejection together, without touching repository instructions.
test_instruction_scan_ownership() (
  local fixture active output line unsafe failures=0
  local -a active_files=(CLAUDE.md AGENTS.md .claude/commands/setup.md
    .claude/worktrees-guide.md docs/guides/setup.md)
  fixture=$(mktemp -d)
  trap 'rm -rf -- "$fixture"' EXIT
  mkdir -p "$fixture/.claude/commands" "$fixture/docs/guides" \
    "$fixture/docs/rca" "$fixture/docs/plans" \
    "$fixture/.claude/worktrees/archived/docs/rca" \
    "$fixture/.claude/worktrees/archived/docs/plans" \
    "$fixture/.claude/worktrees/archived/.claude/commands"
  for active in "${active_files[@]}"; do
    printf '%s\n' 'Use npm run prisma:push:local.' > "$fixture/$active"
  done
  for active in docs/rca/history.md docs/plans/history.md \
    .claude/worktrees/archived/docs/rca/history.md \
    .claude/worktrees/archived/docs/plans/history.md \
    .claude/worktrees/archived/CLAUDE.md \
    .claude/worktrees/archived/AGENTS.md \
    .claude/worktrees/archived/.claude/commands/setup.md; do
    printf '%s\n' 'npx prisma db push' > "$fixture/$active"
  done
  if ! output=$(assert_safe_instruction_docs "$fixture" 2>&1); then
    printf '%s\n' "$output" >&2
    echo 'instruction scanner included an independent worktree or historical docs' >&2
    exit 1
  fi
  for active in "${active_files[@]}"; do
    printf '%s\n' 'npx prisma db push' > "$fixture/$active"
    # Keep diagnostics larger than a pipe buffer: a matching first line must
    # not make an early-exiting grep SIGPIPE the diagnostic producer.
    if [ "$active" = docs/guides/setup.md ]; then
      for ((line = 0; line < 2048; line++)); do
        printf '%s\n' 'npx prisma db push' >> "$fixture/$active"
      done
    fi
    if output=$(assert_safe_instruction_docs "$fixture" 2>&1); then
      echo "instruction scanner accepted unsafe active file: $active" >&2
      exit 1
    fi
    if ! grep -Fq "$active:1:" <<< "$output"; then
      echo "instruction scanner did not identify unsafe active file: $active" >&2
      exit 1
    fi
    printf '%s\n' 'Use npm run prisma:push:local.' > "$fixture/$active"
  done
  for unsafe in \
    'DATABASE_URL=postgresql://u:p@localhost.evil.example/db DIRECT_URL=postgresql://u:p@localhost/db npx prisma db push' \
    'DATABASE_URL=postgresql://u:p@localhost/db DIRECT_URL=postgresql://u:p@127.0.0.1.evil.example/db npx prisma db push' \
    'DATABASE_URL=postgresql://u:p@localhost/db DIRECT_URL=postgresql://u:p@localhost/db echo ok && npx prisma db push' \
    'DATABASE_URL=postgresql://u:p@localhost/db DIRECT_URL=postgresql://u:p@localhost/db npx prisma db push && npx prisma db push' \
    'echo "DATABASE_URL=postgresql://u:p@localhost/db DIRECT_URL=postgresql://u:p@localhost/db"; npx prisma db push' \
    'DATABASE_URL=postgresql://u:p@localhost/db DIRECT_URL=postgresql://u:p@localhost/db `npx prisma db push`' \
    'DATABASE_URL=postgresql://u:p@localhost/db DIRECT_URL=postgresql://u:p@localhost/db $(npx prisma db push)'; do
    printf '%s\n' "$unsafe" > "$fixture/docs/guides/unsafe.md"
    if output=$(assert_safe_instruction_docs "$fixture" 2>&1); then
      echo "instruction scanner accepted remote or unscoped push: $unsafe" >&2
      failures=$((failures + 1))
    fi
  done
  rm "$fixture/docs/guides/unsafe.md"
  if [ "$failures" -ne 0 ]; then
    exit 1
  fi
  printf '%s\n' \
    'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/test \' \
    'DIRECT_URL=postgresql://postgres:postgres@127.0.0.1:5432/test npx prisma db push' \
    > "$fixture/docs/guides/local.md"
  assert_safe_instruction_docs "$fixture"
  for safe in \
    'cd back-end && DATABASE_URL=postgresql://u:p@localhost:5432/db DIRECT_URL=postgresql://u:p@127.0.0.1/db npx prisma db push' \
    'env DIRECT_URL="postgresql://u:p@localhost/db" DATABASE_URL="postgresql://u:p@localhost/db" npx --no-install prisma db push' \
    '`DATABASE_URL=postgresql://u:p@localhost/db DIRECT_URL=postgresql://u:p@localhost/db npx prisma db push`'; do
    printf '%s\n' "$safe" > "$fixture/docs/guides/local.md"
    assert_safe_instruction_docs "$fixture"
  done
  echo 'instruction scanner workspace ownership and active safety: PASS'
)

test_instruction_scan_ownership
ROOT=$(cd "$(dirname "$SCRIPT")/../.." && pwd)
assert_safe_instruction_docs "$ROOT"

# The pre-push User.phone normalizer rewrites rows, so it must refuse remote
# targets exactly like the push wrapper.
NORMALIZE="$(dirname "$SCRIPT")/normalize-local-user-phones.sh"
if NORMALIZE_LOCAL_USER_PHONES_DRY_RUN=1 bash "$NORMALIZE" "$REMOTE_URL" >/dev/null 2>&1; then
  echo "User.phone normalizer remote-target guard failed" >&2
  exit 1
fi
NORMALIZE_LOCAL_USER_PHONES_DRY_RUN=1 bash "$NORMALIZE" "$LOCAL_URL" | grep -Fq 'validation passed'

# Exercise the real SQL on a scratch database when a local Postgres is up:
# blanks become NULL, the oldest row keeps a duplicated phone, reruns are no-ops.
ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres
# Only when a local server accepts these credentials with a role that may create
# the scratch database; otherwise the SQL check is reported as skipped.
can_create_scratch_db() {
  command -v psql >/dev/null 2>&1 || return 1
  [ "$(psql "$ADMIN_URL" -Atc \
    'SELECT rolsuper OR rolcreatedb FROM pg_roles WHERE rolname = current_user' \
    2>/dev/null)" = t ]
}
if can_create_scratch_db; then
  SCRATCH_DB="phone_normalize_test_$$"
  SCRATCH_URL="postgresql://postgres:postgres@localhost:5432/$SCRATCH_DB"
  psql "$ADMIN_URL" -qc "CREATE DATABASE $SCRATCH_DB" >/dev/null
  trap 'psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $SCRATCH_DB" >/dev/null 2>&1 || true' EXIT
  psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL'
CREATE TABLE "User" ("userId" text PRIMARY KEY, "phone" text, "createdAt" timestamp NOT NULL);
INSERT INTO "User" VALUES
  ('blank-a', '', now()), ('blank-b', '  ', now()),
  ('dup-newer', '+15550001111', now()),
  ('dup-oldest', '+15550001111', now() - interval '1 day'),
  ('solo', '+15550002222', now()), ('none', NULL, now());
SQL
  bash "$NORMALIZE" "$SCRATCH_URL" >/dev/null
  bash "$NORMALIZE" "$SCRATCH_URL" >/dev/null
  actual=$(psql "$SCRATCH_URL" -Atc \
    "SELECT string_agg(\"userId\" || '=' || coalesce(\"phone\", 'NULL'), ',' ORDER BY \"userId\") FROM \"User\"")
  expected='blank-a=NULL,blank-b=NULL,dup-newer=NULL,dup-oldest=+15550001111,none=NULL,solo=+15550002222'
  if [ "$actual" != "$expected" ]; then
    echo "User.phone normalizer produced $actual, expected $expected" >&2
    exit 1
  fi
  psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -qc \
    'CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone")' >/dev/null
  echo "local User.phone normalization SQL: PASS"

  # db push ignores the hand-written workflow functions/triggers in migrations.
  # A database built only by this wrapper must still carry them, or local unit
  # tests (workflow-terminal-cleanup) run against a schema prod does not have.
  PUSH_DB="prisma_local_push_ddl_test_$$"
  PUSH_URL="postgresql://postgres:postgres@localhost:5432/$PUSH_DB"
  psql "$ADMIN_URL" -qc "CREATE DATABASE $PUSH_DB" >/dev/null
  trap 'psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $SCRATCH_DB" >/dev/null 2>&1 || true;
        psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $PUSH_DB" >/dev/null 2>&1 || true' EXIT
  if ! push_output=$(cd "$(dirname "$SCRIPT")/.." && DB_CONTAINER=victoria-db-unrelated-fixture \
      DATABASE_URL="$PUSH_URL" DIRECT_URL="$PUSH_URL" bash "$SCRIPT" --skip-generate 2>&1); then
    printf '%s\n' "$push_output" >&2
    echo "local Prisma push into a scratch database failed" >&2
    exit 1
  fi
  triggers=$(psql "$PUSH_URL" -Atc \
    "SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal")
  for trigger in Agent_enqueue_temporal_workflow_cleanup Agent_fence_descendant_workflow_start \
      Message_trajectory_search_sync; do
    case ",$triggers," in
      *",$trigger,"*) ;;
      *) echo "local Prisma push left $PUSH_DB without trigger $trigger (have: ${triggers:-none})" >&2; exit 1 ;;
    esac
  done
  echo "local Prisma push applies workflow DDL: PASS"
else
  echo "local User.phone normalization SQL: skipped (no local Postgres)"
fi

echo "local Prisma push safety tests: PASS"
