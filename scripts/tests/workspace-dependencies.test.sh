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
{"name":"test-front-end","private":true,"dependencies":{"react":"1.0.0"}}
JSON
cat > "$TEMP_ROOT/bin/npm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  pkg) printf '{"test-front-end":"test-front-end"}\n' ;;
  ls) exit 0 ;;
  install)
    printf '%s\n' "$*" >> .install-calls
    mkdir -p front-end/node_modules/react
    printf '{"name":"react","version":"1.0.0"}\n' > front-end/node_modules/react/package.json
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

echo "Workspace dependency preflight checks passed."
