#!/usr/bin/env bash
# Render backend build reproducibility (docs/rca/cases/
# 2026-07-25-floating-dep-spec-without-frontend-lockfile-breaks-render-build.md).
#
# Runs back-end/scripts/render-build.sh, the committed Render build, on a clean
# copy of the source tree (no node_modules, no root lockfile) exactly as Render's
# fresh checkout sees it, with Render's NODE_ENV=production. It must:
#   - install only back-end/package-lock.json (no repo-root workspace install),
#   - leave that lockfile byte-identical (npm ci also fails when it is stale),
#   - produce dist/bootstrap.js,
#   - resolve every runtime import in dist/ from back-end/node_modules alone, so
#     no dependency silently relied on root-workspace hoisting.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/render-backend-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Copy the tracked + untracked (non-ignored) source the way a fresh clone has it.
# The workspace manifests stay present so npm sees the same repo-root workspace.
(
  cd "$ROOT"
  git ls-files -z --cached --others --exclude-standard -- \
    package.json back-end front-end/package.json front-end/package-lock.json |
    while IFS= read -r -d '' path; do
      [ -e "$path" ] && printf '%s\0' "$path"
    done |
    tar --null -T - -cf -
) | tar -xf - -C "$WORK"
mkdir -p "$WORK/agents"
back_lock="$WORK/back-end/package-lock.json"
[ -f "$back_lock" ] || fail "back-end/package-lock.json is not committed"
[ ! -e "$WORK/package-lock.json" ] || fail "fixture unexpectedly has a root lockfile"
lock_before="$(sha256sum "$back_lock" | cut -d' ' -f1)"

log="$WORK/render-build.log"
if ! (cd "$WORK/back-end" && env NODE_ENV=production npm_config_update_notifier=false \
  bash scripts/render-build.sh) >"$log" 2>&1; then
  tail -40 "$log" >&2
  fail "back-end/scripts/render-build.sh failed on a clean checkout"
fi
echo "PASS: render-build.sh builds a clean checkout under NODE_ENV=production"

[ ! -e "$WORK/node_modules" ] || fail "the build installed the repo-root workspace graph"
[ ! -e "$WORK/package-lock.json" ] || fail "the build resolved a repo-root lockfile"
echo "PASS: only back-end/package-lock.json was installed (no root workspace install)"

[ "$(sha256sum "$back_lock" | cut -d' ' -f1)" = "$lock_before" ] ||
  fail "the build rewrote back-end/package-lock.json"
echo "PASS: back-end/package-lock.json is unchanged"

[ -f "$WORK/back-end/dist/bootstrap.js" ] || fail "dist/bootstrap.js was not produced"
echo "PASS: dist/bootstrap.js produced"

(cd "$WORK/back-end" && node - <<'NODE') || fail "dist/ imports a package outside back-end/package-lock.json"
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const dist = path.resolve('dist');
const specs = new Set();
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.js')) {
      const source = fs.readFileSync(file, 'utf8');
      for (const m of source.matchAll(/\brequire\(\s*["']([^"'.\/][^"']*)["']\s*\)/g)) specs.add(m[1]);
    }
  }
};
walk(dist);
const packageName = (spec) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
const missing = [];
for (const spec of specs) {
  const bare = spec.replace(/^node:/, '');
  if (spec.startsWith('node:') || builtinModules.includes(bare.split('/')[0])) continue;
  // Only plausible npm package names; skips regex/string literals.
  if (!/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(\/.*)?$/i.test(spec)) continue;
  try {
    require.resolve(`${packageName(spec)}/package.json`, { paths: [dist] });
  } catch {
    try {
      require.resolve(spec, { paths: [dist] });
    } catch {
      missing.push(spec);
    }
  }
}
if (missing.length > 0) {
  console.error(`unresolved runtime imports: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`PASS: ${specs.size} runtime package imports resolve from back-end/node_modules`);
NODE

echo "render-backend-build: all cases passed"
