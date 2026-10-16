#!/usr/bin/env bash
# The former clone-recovery owner now verifies the allocation-free queue entry.
# Native bank recovery is exercised by retained-agent-machine and worker-pool tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
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
    assert plan['imageRef'] == 'registry.fly.io/test-prod@sha256:' + 'd' * 64
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
[[ "$*" == 'deploy --local-only --build-only --push --image-label '* ]] || exit 90
[[ "$*" == *' -a test-prod' ]] || exit 91
printf 'build\n' >> "$TEST_QUEUE_DIR/journal"
exit "${TEST_BUILD_FAILURE:-0}"
SH
cat > "$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == 'buildx imagetools inspect registry.fly.io/test-prod:cutover-'* ]] || exit 92
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
  archive\ *:agents) tar -cf - --files-from /dev/null;;
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
bash "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" > "$TMP/normal.log" 2>&1
[[ "$(cat "$TMP/journal")" == $'build\nenqueue\nrun' ]]
FIRST_JOB=$(cat "$TMP/job-id")
export BUILD_ID=cccccccccccccccccccccccccccccccccccccccc
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
echo 'worker pool entry: PASS (allocation-free build, immutable enqueue, shared runner, failures before admission)'
