#!/usr/bin/env python3
"""Turn a `pg_dump --schema-only` of the prod public schema into a single
Prisma-consumable baseline migration.

Transformations (see docs/plans or the migration header for why):
  - Drop psql meta-commands (\\restrict / \\unrestrict) — Prisma executes SQL
    over the DB protocol, not through psql, so these are syntax errors.
  - Drop `CREATE SCHEMA public;` — public always exists on a fresh DB.
  - Drop every statement touching `_prisma_migrations` — Prisma owns that table.
  - Inject `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;` — the
    Person trigram GIN index uses public.gin_trgm_ops and pg_dump omits the
    extension.
Kept as-is: SET header + set_config(search_path,''), public.-qualified names,
auth.uid()/realtime.* refs (present on any fresh Supabase project = our prod).
"""
import re
import sys

src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    lines = f.readlines()

# 1) Split into statements while respecting $$-dollar-quoted function bodies.
statements = []
buf = []
in_dollar = False
for line in lines:
    stripped = line.strip()
    # psql meta-commands: drop outright (only meaningful outside dollar quotes).
    if not in_dollar and stripped.startswith("\\"):
        continue
    # pg_dump session-tuning SETs are version-specific (e.g. transaction_timeout
    # is PG17+, breaking a fresh PG15 Supabase deploy). Drop all of them EXCEPT
    # check_function_bodies=false, which the broadcast trigger functions need
    # (their bodies reference realtime.broadcast_changes, absent at DDL time).
    if not in_dollar and stripped.startswith("SET ") and "check_function_bodies" not in stripped:
        continue
    # pg_dump sets a session-level empty search_path (relies on its own
    # public.-qualified names). Prisma applies the migration, then records it in
    # the UNQUALIFIED `_prisma_migrations` table — with an empty search_path that
    # resolution fails (P1014). Every object here is already public.-qualified,
    # so drop this line and let the default search_path stand.
    if not in_dollar and stripped.startswith("SELECT pg_catalog.set_config('search_path'"):
        continue
    buf.append(line)
    # Count $$ toggles on this line to track dollar-quoted blocks.
    dollars = line.count("$$")
    if dollars % 2 == 1:
        in_dollar = not in_dollar
    if not in_dollar and stripped.endswith(";"):
        statements.append("".join(buf))
        buf = []
if buf:
    statements.append("".join(buf))

# 2) Filter statements.
kept = []
for stmt in statements:
    s = stmt.strip()
    if not s:
        kept.append(stmt)
        continue
    if "_prisma_migrations" in s:
        continue
    kept.append(stmt)

body = "".join(kept)

# `public` always exists on a fresh DB, so its CREATE/COMMENT would error.
# These land mid-statement (preceded by comment lines), so strip by line.
body = re.sub(r"^CREATE SCHEMA public;\n", "", body, flags=re.MULTILINE)
body = re.sub(r"^COMMENT ON SCHEMA public .*;\n", "", body, flags=re.MULTILINE)

# 3) Inject pg_trgm extension right after the SET header block (before the
#    first CREATE), so the trigram index's public.gin_trgm_ops resolves.
ext = "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;\n"
marker = "SET check_function_bodies = false;\n"
if marker in body:
    body = body.replace(marker, marker + "\n" + ext, 1)
else:
    body = ext + body

header = (
    "-- Baseline migration (squash of the pre-2026-07-06 migration history).\n"
    "-- Generated from a pg_dump --schema-only of prod (the source of truth),\n"
    "-- then cleaned by scripts/clean-baseline-dump.py. Reproduces the full prod\n"
    "-- schema: tables, enums, indexes (incl. the pg_trgm expression index),\n"
    "-- functions, broadcast triggers, and RLS policies. Existing environments\n"
    "-- have this marked applied via `prisma migrate resolve`; only a fresh DB\n"
    "-- actually runs it.\n\n"
)
with open(dst, "w") as f:
    f.write(header + body)
print(f"wrote {dst}: {len(kept)} statements kept")
