#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/workspace-dependencies-test.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT

mkdir -p "$TEMP_ROOT/bin" "$TEMP_ROOT/front-end"
cat > "$TEMP_ROOT/package.json" <<'JSON'
{"name":"test-root","private":true,"workspaces":["front-end"]}
JSON
cat > "$TEMP_ROOT/front-end/package.json" <<'JSON'
{"name":"test-front-end","private":true,"dependencies":{"react":"1.0.0","fsevents":"1.0.0"},"optionalDependencies":{"fsevents":"2.0.0"}}
JSON
cat > "$TEMP_ROOT/bin/npm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  pkg) printf '{"test-front-end":"test-front-end"}\n' ;;
  ls) exit 0 ;;
  install)
    printf '%s\n' "$*" >> .install-calls
    if [ "${FAIL_WORKSPACE_INSTALL:-0}" = 1 ]; then
      exit 1
    fi
    mkdir -p front-end/node_modules/react
    printf '{"name":"react","version":"1.0.0"}\n' > front-end/node_modules/react/package.json
    ;;
  ci)
    printf '%s::%s\n' "$(pwd -P)" "$*" >> "$TEMP_ROOT/.ci-calls"
    mkdir -p node_modules/react
    printf '{"name":"react","version":"1.0.0"}\n' > node_modules/react/package.json
    ;;
  *) exit 2 ;;
esac
SH
chmod +x "$TEMP_ROOT/bin/npm"

(
  cd "$TEMP_ROOT"
  PATH="$TEMP_ROOT/bin:$PATH" bash "$ROOT_DIR/scripts/ensure-workspace-dependencies.sh" front-end
  PATH="$TEMP_ROOT/bin:$PATH" bash "$ROOT_DIR/scripts/ensure-workspace-dependencies.sh" front-end
)

[ "$(wc -l < "$TEMP_ROOT/.install-calls" | tr -d ' ')" = "1" ] || {
  echo "FAIL: missing workspace dependencies must trigger exactly one install" >&2
  exit 1
}
grep -Fq -- '--workspace=front-end' "$TEMP_ROOT/.install-calls" || {
  echo "FAIL: install must target the incomplete workspace" >&2
  exit 1
}

rm -rf "$TEMP_ROOT/front-end/node_modules"
printf '{}\n' > "$TEMP_ROOT/front-end/package-lock.json"
: > "$TEMP_ROOT/.install-calls"
: > "$TEMP_ROOT/.ci-calls"
(
  cd "$TEMP_ROOT"
  FAIL_WORKSPACE_INSTALL=1 TEMP_ROOT="$TEMP_ROOT" PATH="$TEMP_ROOT/bin:$PATH" \
    bash "$ROOT_DIR/scripts/ensure-workspace-dependencies.sh" front-end
)

grep -Fq -- '--workspace=front-end' "$TEMP_ROOT/.install-calls" || {
  echo "FAIL: fallback must follow a failed workspace-scoped install" >&2
  exit 1
}
FRONT_END_REALPATH="$(cd "$TEMP_ROOT/front-end" && pwd -P)"
grep -Fq -- "$FRONT_END_REALPATH::ci --workspaces=false --no-audit --no-fund" \
  "$TEMP_ROOT/.ci-calls" || {
  echo "FAIL: a workspace install crash must fall back to isolated npm ci" >&2
  exit 1
}

# npm ls --depth=0 exits 1 for "invalid" URL/tarball packages that are still
# on disk (xlsx from cdn.sheetjs.com, leftover workspace copies). A follow-up
# `npm install --workspace=` then prunes a healthy hoisted tree (vite gone).
INVALID_LS_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/workspace-dependencies-invalid.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT" "$INVALID_LS_ROOT"' EXIT
mkdir -p "$INVALID_LS_ROOT/bin" "$INVALID_LS_ROOT/front-end/node_modules/react"
cat > "$INVALID_LS_ROOT/package.json" <<'JSON'
{"name":"test-root","private":true,"workspaces":["front-end"]}
JSON
cat > "$INVALID_LS_ROOT/front-end/package.json" <<'JSON'
{"name":"test-front-end","private":true,"dependencies":{"react":"1.0.0","xlsx":"https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"}}
JSON
printf '{"name":"react","version":"1.0.0"}\n' > "$INVALID_LS_ROOT/front-end/node_modules/react/package.json"
mkdir -p "$INVALID_LS_ROOT/front-end/node_modules/xlsx"
printf '{"name":"xlsx","version":"0.20.3"}\n' > "$INVALID_LS_ROOT/front-end/node_modules/xlsx/package.json"
cat > "$INVALID_LS_ROOT/bin/npm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  pkg) printf '{"test-front-end":"test-front-end"}\n' ;;
  ls)
    echo "npm error code ELSPROBLEMS" >&2
    echo "npm error invalid: xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz" >&2
    exit 1
    ;;
  install)
    printf '%s\n' "$*" >> .install-calls
    ;;
  *) exit 2 ;;
esac
SH
chmod +x "$INVALID_LS_ROOT/bin/npm"
(
  cd "$INVALID_LS_ROOT"
  PATH="$INVALID_LS_ROOT/bin:$PATH" bash "$ROOT_DIR/scripts/ensure-workspace-dependencies.sh" front-end
  PATH="$INVALID_LS_ROOT/bin:$PATH" bash "$ROOT_DIR/scripts/ensure-workspace-dependencies.sh" front-end
)
if [ -f "$INVALID_LS_ROOT/.install-calls" ]; then
  echo "FAIL: npm ls invalid-but-installed must not retrigger workspace install (prunes hoisted bins)" >&2
  cat "$INVALID_LS_ROOT/.install-calls" >&2
  exit 1
fi

echo "Workspace dependency preflight checks passed."
