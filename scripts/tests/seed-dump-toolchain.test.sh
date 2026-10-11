#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SAVE="$ROOT_DIR/scripts/save-seed-dump.sh"
RUN_SH="$ROOT_DIR/scripts/run.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/out"

cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SEED_DUMP_TEST_LOG"
printf 'container-compatible-archive'
EOF
chmod +x "$TMP/bin/docker"

cat > "$TMP/bin/pg_dump" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SEED_DUMP_TEST_LOG"
printf 'system-compatible-archive'
EOF
chmod +x "$TMP/bin/pg_dump"

export PATH="$TMP/bin:$PATH"
export SEED_DUMP_TEST_LOG="$TMP/calls.log"

bash "$SAVE" "$TMP/out/container.dump" localhost 5432 postgres victoria postgres-16
grep -qx 'exec postgres-16 pg_dump -U postgres -Fc victoria' "$SEED_DUMP_TEST_LOG"
grep -qx 'container-compatible-archive' "$TMP/out/container.dump"
echo "PASS: Docker databases are dumped with their matching container pg_dump"

: > "$SEED_DUMP_TEST_LOG"
bash "$SAVE" "$TMP/out/system.dump" localhost 55432 postgres victoria
# localhost is remapped to 127.0.0.1 so Cloud VMs with scram-on-::1 still
# authenticate with the md5 postgres/postgres password on IPv4.
grep -qx -- '-h 127.0.0.1 -p 55432 -U postgres -Fc victoria' "$SEED_DUMP_TEST_LOG"
grep -qx 'system-compatible-archive' "$TMP/out/system.dump"
echo "PASS: system databases are dumped with the colocated host pg_dump (localhost→127.0.0.1)"

cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'partial'
exit 17
EOF
chmod +x "$TMP/bin/docker"
printf 'known-good-archive' > "$TMP/out/failed.dump"
if bash "$SAVE" "$TMP/out/failed.dump" localhost 5432 postgres victoria postgres-16; then
    echo "FAIL: failed pg_dump unexpectedly succeeded" >&2
    exit 1
fi
grep -qx 'known-good-archive' "$TMP/out/failed.dump"
if find "$TMP/out" -name 'failed.dump.tmp.*' -print -quit | grep -q .; then
    echo "FAIL: failed pg_dump left a partial archive" >&2
    exit 1
fi
echo "PASS: failed dumps preserve a known-good archive and leave no partial"

grep -q '_SEED_DUMP_CONTAINER="$DB_CONTAINER"' "$RUN_SH"
SAVE_CALL="$(grep -A2 'bash scripts/save-seed-dump.sh' "$RUN_SH")"
grep -q '"$LOCAL_DB_NAME"' <<<"$SAVE_CALL"
grep -q '"$_SEED_DUMP_CONTAINER"' <<<"$SAVE_CALL"
echo "PASS: run.sh passes the exact database and Docker container to the helper"

RESTORE_FAILURE="$(grep -A7 'restore failed — falling back' "$RUN_SH")"
grep -q 'rm -f "$_SEED_DUMP" "${_SEED_DUMP}.schemahash"' <<<"$RESTORE_FAILURE"
echo "PASS: run.sh invalidates an archive already proven unrestorable"
# ngrok reserved-domains list page size must stay <= 100 (ERR_NGROK_233).
grep -qE -- '--limit 100\b' "$RUN_SH" || { echo "FAIL: run.sh must list reserved domains with --limit 100" >&2; exit 1; }
! grep -qE -- '--limit 1000\b' "$RUN_SH" || { echo "FAIL: run.sh still requests --limit 1000 from ngrok" >&2; exit 1; }
echo "PASS: run.sh respects ngrok reserved-domains page-size cap"

# Domain existence checks must compare JSON values literally — interpolating
# $domain into grep treats dots as regex wildcards and can false-match.
if grep -nE 'grep -q.*"domain".*"\$domain"' "$RUN_SH" >/dev/null; then
  echo "FAIL: run.sh must not regex-match reserved domain names via grep" >&2
  exit 1
fi
grep -q 'item.get("domain") == requested_domain' "$RUN_SH" \
  || { echo "FAIL: run.sh must literally compare reserved domain JSON values" >&2; exit 1; }
echo "PASS: run.sh compares reserved domains as exact JSON values"

# Reserved-domain API calls must use the NGROK_API_KEY env (not --api-key argv)
# and must fail closed on malformed listing JSON instead of creating a domain.
ensure_fn=$(sed -n '/^ensure_ngrok_domain_reserved()/,/^}$/p' "$RUN_SH")
grep -q 'export NGROK_API_KEY' <<<"$ensure_fn" \
  || { echo "FAIL: ensure_ngrok_domain_reserved must export NGROK_API_KEY" >&2; exit 1; }
if echo "$ensure_fn" | grep -vE '^[[:space:]]*#' | grep -qE -- '--api-key[[:space:]]'; then
  echo "FAIL: ensure_ngrok_domain_reserved must not pass --api-key on argv" >&2
  exit 1
fi
grep -q 'malformed' <<<"$ensure_fn" \
  || { echo "FAIL: ensure_ngrok_domain_reserved must fail on malformed listing JSON" >&2; exit 1; }
grep -q 'raw.find("{")' <<<"$ensure_fn" \
  || { echo "FAIL: ensure_ngrok_domain_reserved must tolerate ngrok CLI HTTP status prefixes before JSON" >&2; exit 1; }
# Behavioral cement: a "200 OK\\n{...}" listing still resolves an existing domain.
status_prefixed_listing='200 OK
{"next_page_uri": null, "reserved_domains": [{"id": "rd_test", "domain": "rose-status-prefix.ngrok.app"}]}'
parse_out=$(printf '%s\n' "$status_prefixed_listing" | python3 -c '
import json, sys
requested_domain = sys.argv[1]
raw = sys.stdin.read()
brace = raw.find("{")
if brace < 0:
    print("malformed:no JSON object in reserved-domains listing", file=sys.stderr)
    sys.exit(2)
data = json.loads(raw[brace:])
reserved_domains = data.get("reserved_domains") or []
if any(item.get("domain") == requested_domain for item in reserved_domains if isinstance(item, dict)):
    print("found")
    sys.exit(0)
print("done")
' "rose-status-prefix.ngrok.app") || {
  echo "FAIL: status-prefixed ngrok listing must parse" >&2
  exit 1
}
[ "$parse_out" = "found" ] || {
  echo "FAIL: status-prefixed listing should report found, got: $parse_out" >&2
  exit 1
}
# Behavioral cement: pagination cursor extraction must survive bash single-quoting
# of the python -c body (single-quoted ['id'] terminates the shell string early).
paginated_listing='200 OK
{"next_page_uri": "https://api.ngrok.com/reserved_domains?before_id=rd_page&limit=100", "reserved_domains": [{"id": "rd_page", "domain": "rose-page-one.ngrok.app"}]}'
page_parse=$(printf '%s\n' "$paginated_listing" | python3 -c '
import json, sys
requested_domain = sys.argv[1]
raw = sys.stdin.read()
brace = raw.find("{")
if brace < 0:
    print("malformed:no JSON object in reserved-domains listing", file=sys.stderr)
    sys.exit(2)
data = json.loads(raw[brace:])
reserved_domains = data.get("reserved_domains") or []
if any(item.get("domain") == requested_domain for item in reserved_domains if isinstance(item, dict)):
    print("found")
    sys.exit(0)
if data.get("next_page_uri"):
    if not reserved_domains or not isinstance(reserved_domains[-1], dict) or not reserved_domains[-1].get("id"):
        print("malformed:missing before_id cursor", file=sys.stderr)
        sys.exit(2)
    print("next:" + reserved_domains[-1]["id"])
else:
    print("done")
' "rose-missing.ngrok.app") || {
  echo "FAIL: paginated ngrok listing must parse" >&2
  exit 1
}
[ "$page_parse" = "next:rd_page" ] || {
  echo "FAIL: paginated listing should report next cursor, got: $page_parse" >&2
  exit 1
}
echo "$ensure_fn" | grep -Fq 'print("next:" + reserved_domains[-1]["id"])' \
  || { echo "FAIL: ensure_ngrok_domain_reserved must use bash-safe next-cursor print" >&2; exit 1; }
if echo "$ensure_fn" | grep -vE '^[[:space:]]*#' | grep -Fq "['id']"; then
  echo "FAIL: ensure_ngrok_domain_reserved still embeds bash-breaking ['id'] inside single quotes" >&2
  exit 1
fi
echo "PASS: run.sh reserved-domain listing uses env key and fails closed on bad JSON"
echo "PASS: run.sh reserved-domain listing tolerates ngrok CLI HTTP status prefixes"
echo "PASS: run.sh reserved-domain pagination cursor survives bash single-quoting"

# Create rejection (e.g. ERR_NGROK_415 at the 100-domain cap) must warn and
# return — never bare-exit — or every stack on a full ngrok account dies before
# the ephemeral/cloudflare fallback can run.
ensure_fn=$(sed -n '/^ensure_ngrok_domain_reserved()/,/^}$/p' "$RUN_SH")
grep -q 'tunnel start / fallback is authoritative' <<<"$ensure_fn" \
  || { echo "FAIL: ensure_ngrok_domain_reserved must continue after create rejection" >&2; exit 1; }
# The create-failure branch must not exit 1 in the default (non-soft) path.
create_fail_branch=$(echo "$ensure_fn" | awk '/Reserving ngrok domain/,/^}$/')
if echo "$create_fail_branch" | grep -vE 'failure_mode.*soft' | grep -qE '^\s*exit 1\s*$'; then
  echo "FAIL: ensure_ngrok_domain_reserved still exits 1 on create rejection" >&2
  exit 1
fi
grep -q 'return 0' <<<"$create_fail_branch" \
  || { echo "FAIL: ensure_ngrok_domain_reserved default path must return 0 after create rejection" >&2; exit 1; }
# Primary reserved-domain start must soft-reserve and fall back to ephemeral
# when reservation fails (otherwise --domain binds a hostname that was never
# created and ngrok_public_tunnel_fail tears the stack down).
awk '/^start_ngrok_public_tunnel\(\) \{/,/^}$/' "$RUN_SH" > "$TMP/start_ngrok_public.sh"
grep -q "ensure_ngrok_domain_reserved \"\$WORKTREE_DOMAIN\" soft" "$TMP/start_ngrok_public.sh" \
  || { echo "FAIL: start_ngrok_public_tunnel must soft-reserve before binding --domain" >&2; exit 1; }
grep -q 'ngrok_configure_endpoint_mode 1' "$TMP/start_ngrok_public.sh" \
  || { echo "FAIL: start_ngrok_public_tunnel must fall back to ephemeral when reserve fails" >&2; exit 1; }
echo "PASS: run.sh reserved-domain create rejection is advisory + ephemeral fallback"

