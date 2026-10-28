#!/usr/bin/env bash
# The former clone-recovery owner now verifies the allocation-free queue entry.
# Native bank recovery is exercised by retained-agent-machine and worker-pool tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/docker-config"
export DOCKER_CONFIG="$TMP/docker-config"
export TEST_REAL_NODE="$(command -v node)"
export TEST_QUEUE_DIR="$TMP"
cat > "$TMP/bin/node" <<'PY'
#!/usr/bin/env python3
import hashlib, json, os, pathlib, sys
args = sys.argv[1:]
folder = pathlib.Path(os.environ['TEST_QUEUE_DIR'])
if 'scripts/worker-deployment-queue.ts' not in args:
    os.execv(os.environ['TEST_REAL_NODE'], [os.environ['TEST_REAL_NODE'], *args])
action = args[args.index('scripts/worker-deployment-queue.ts') + 1]
with (folder / 'journal').open('a') as log:
    log.write(action + '\n')
if action == 'enqueue':
    path = pathlib.Path(args[args.index('--plan') + 1])
    assert path.stat().st_mode & 0o777 == 0o600
    plan = json.loads(path.read_text())
    assert plan['buildId'] == plan['sourceCommit']
    assert plan['imageRef'] == 'registry.fly.io/test-prod@sha256:' + os.environ.get('TEST_EXPECT_DIGEST_CHAR', 'd') * 64
    assert len(plan['surfaceHash']) == 12
    identity = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()
    (folder / 'plan-readback.json').write_text(json.dumps(plan))
    (folder / 'job-id').write_text(identity)
    print(json.dumps({'jobId': identity, 'identity': plan, 'stage': 'QUEUED'}))
elif action == 'run':
    assert args[args.index('--job-id') + 1] == (folder / 'job-id').read_text()
    command = args[args.index('--') + 1:]
    assert command[0] == 'python3' and command[1].endswith('/scripts/worker_pool_cutover.py')
else:
    raise AssertionError('unexpected queue operation: ' + action)
PY
cat > "$TMP/bin/flyctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'auth docker' ]]; then
  printf 'auth\n' >> "$TEST_QUEUE_DIR/journal"
  if [[ "${TEST_AUTH_FAILURE:-0}" != 0 ]]; then exit "$TEST_AUTH_FAILURE"; fi
  [[ "$FLY_API_TOKEN" == fixture-token ]]
  printf '{"auths":{"registry.fly.io":{"auth":"offline-fixture"}}}\n' > "$DOCKER_CONFIG/config.json"
  exit 0
fi
[[ "$*" == 'deploy --local-only --build-only --push --image-label '* ]] || exit 90
[[ "$*" == *' -a test-prod' ]] || exit 91
printf 'build\n' >> "$TEST_QUEUE_DIR/journal"
exit "${TEST_BUILD_FAILURE:-0}"
SH
cat > "$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "buildx imagetools inspect registry.fly.io/test-prod:prebuilt-${TEST_PREBUILT_TREE:-none} "* ]]; then
  printf 'inspect-prebuilt\n' >> "$TEST_QUEUE_DIR/journal"
  [[ "${TEST_PREBUILT_PRESENT:-0}" == 1 ]] || exit 1
  printf '"sha256:%064d"\n' 0 | tr 0 e
  exit 0
fi
[[ "$*" == 'buildx imagetools inspect registry.fly.io/test-prod:cutover-'* ]] || exit 92
if ! python3 - <<'PYAUTH'
import json, os, pathlib
path = pathlib.Path(os.environ['DOCKER_CONFIG']) / 'config.json'
assert path.is_file(), 'clean Docker config has no Fly registry credential'
assert json.loads(path.read_text())['auths']['registry.fly.io']['auth'] == 'offline-fixture'
PYAUTH
then
  echo 'offline registry inspect rejected unauthenticated Docker (401)' >&2
  exit 93
fi
printf 'inspect\n' >> "$TEST_QUEUE_DIR/journal"
printf '"sha256:%064d"\n' 0 | tr 0 d
SH
cat > "$TMP/bin/npm" <<'SH'
#!/usr/bin/env bash
[[ "$*" == 'ci --workspaces=false --ignore-scripts' ]]
SH
cat > "$TMP/bin/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" != -C ]] || shift 2
case "$*" in
  'rev-parse HEAD') printf '%s\n' "${TEST_CHECKOUT_SHA:-$BUILD_ID}";;
  'diff --quiet HEAD') exit "${TEST_DIRTY_SOURCE:-0}";;
  'ls-files --others --exclude-standard') exit 0;;
  # Only the sparse-safe pathspec form is accepted: a bare archive would lazily
  # fetch every excluded benchmark blob in the blob-filtered workflow checkout.
  "archive $BUILD_ID:agents -- . :(exclude)benchmarks :(exclude)tests") tar -cf - --files-from /dev/null;;
  rev-parse\ *:agents) [[ -n "${TEST_PREBUILT_TREE:-}" ]] || exit 95; printf '%s\n' "$TEST_PREBUILT_TREE";;
  *) exit 95;;
esac
SH
cat > "$TMP/bin/npx" <<'SH'
#!/usr/bin/env bash
[[ "$*" == 'prisma generate' ]]
SH
chmod 755 "$TMP/bin/"*
export PATH="$TMP/bin:$PATH" FLY_API_TOKEN=fixture-token APP=test-prod
export DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:1/not-contacted
export BUILD_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export SURFACE_HASH=bbbbbbbbbbbb DEPLOYMENT_TOKEN=attempt-one
export DEPLOY_REUSE_ONLY=1
: > "$TMP/journal"
if bash "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" > "$TMP/normal.log" 2>&1; then
  :
else
  result=$?
  cat "$TMP/normal.log" >&2
  exit "$result"
fi
[[ "$(cat "$TMP/journal")" == $'build\nauth\ninspect\nenqueue\nrun' ]]
FIRST_JOB=$(cat "$TMP/job-id")
export BUILD_ID=cccccccccccccccccccccccccccccccccccccccc
rm "$DOCKER_CONFIG/config.json"
bash "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" > "$TMP/next.log" 2>&1
[[ "$FIRST_JOB" != "$(cat "$TMP/job-id")" ]]
: > "$TMP/journal"
if DEPLOY_REUSE_ONLY=0 bash "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" > "$TMP/creation.log" 2>&1; then
  echo 'unsafe fresh allocation was accepted' >&2; exit 1
fi
[[ ! -s "$TMP/journal" ]]
if BUILD_ID=wrong bash "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" > "$TMP/invalid.log" 2>&1; then
  echo 'invalid source identity was accepted' >&2; exit 1
fi
[[ ! -s "$TMP/journal" ]]
for source_failure in mismatch dirty; do
  if [[ "$source_failure" == mismatch ]]; then
    export TEST_CHECKOUT_SHA=ffffffffffffffffffffffffffffffffffffffff
  else
    unset TEST_CHECKOUT_SHA
    export TEST_DIRTY_SOURCE=1
  fi
  if bash "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" > "$TMP/source-$source_failure.log" 2>&1; then
    echo 'unqualified build source was accepted' >&2; exit 1
  fi
  [[ ! -s "$TMP/journal" ]]
done
unset TEST_CHECKOUT_SHA TEST_DIRTY_SOURCE
if TEST_BUILD_FAILURE=31 bash "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" > "$TMP/build-failure.log" 2>&1; then
  echo 'failed build was admitted' >&2; exit 1
fi
[[ "$(cat "$TMP/journal")" == build ]]
: > "$TMP/journal"
rm "$DOCKER_CONFIG/config.json"
if TEST_AUTH_FAILURE=33 bash "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" > "$TMP/auth-failure.log" 2>&1; then
  echo 'failed registry authentication was admitted' >&2; exit 1
fi
[[ "$(cat "$TMP/journal")" == $'build\nauth' ]]
[[ ! -e "$DOCKER_CONFIG/config.json" ]]
# Prebuilt promotion: an image prebuilt for this exact agents tree is enqueued
# by digest without rebuilding; a miss falls back to the normal build.
export TEST_PREBUILT_TREE=1111111111111111111111111111111111111111
: > "$TMP/journal"
TEST_PREBUILT_PRESENT=1 TEST_EXPECT_DIGEST_CHAR=e \
  bash "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" > "$TMP/prebuilt.log" 2>&1 ||
  { cat "$TMP/prebuilt.log" >&2; exit 1; }
[[ "$(cat "$TMP/journal")" == $'auth\ninspect-prebuilt\nenqueue\nrun' ]] ||
  { echo 'prebuilt image was not promoted without a rebuild' >&2; cat "$TMP/journal" >&2; exit 1; }
grep -q 'Promoting prebuilt worker image registry.fly.io/test-prod@sha256:e' "$TMP/prebuilt.log"
: > "$TMP/journal"
rm -f "$DOCKER_CONFIG/config.json"
bash "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" > "$TMP/prebuilt-miss.log" 2>&1 ||
  { cat "$TMP/prebuilt-miss.log" >&2; exit 1; }
[[ "$(cat "$TMP/journal")" == $'auth\ninspect-prebuilt\nbuild\nauth\ninspect\nenqueue\nrun' ]] ||
  { echo 'a prebuilt miss must build exactly as before' >&2; cat "$TMP/journal" >&2; exit 1; }
: > "$TMP/journal"
AGENTS_PREBUILT_REUSE=0 TEST_PREBUILT_PRESENT=1 \
  bash "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" > "$TMP/prebuilt-off.log" 2>&1
[[ "$(cat "$TMP/journal")" == $'build\nauth\ninspect\nenqueue\nrun' ]]
unset TEST_PREBUILT_TREE
echo 'worker pool entry: PASS (allocation-free build, immutable enqueue, shared runner, failures before admission)'
