#!/usr/bin/env bash
# Exercise the real cutover script with Fly/npm/Prisma fakes. A Fly clone may
# exist even when the first deploy command timed out waiting for it to start.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/npm" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat > "$TMP/bin/npx" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == *'set-agent-queue-pointer.ts --read'* ]]; then
  echo null
elif [[ "$*" == *'set-agent-queue-pointer.ts --queue'* ]]; then
  echo flip >> "$FAKE_FLY_JOURNAL"
fi
SH
cat > "$TMP/bin/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat > "$TMP/bin/flyctl" <<'PY'
#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
path = Path(os.environ['FAKE_FLY_STATE'])
machines = json.loads(path.read_text())
journal = Path(os.environ['FAKE_FLY_JOURNAL'])

def save():
    path.write_text(json.dumps(machines))

if args[0] == 'deploy':
    print('image: registry.fly.io/test:cutover-abc-token')
elif args[:2] == ['machines', 'list']:
    print(json.dumps(machines))
elif args[:2] == ['machine', 'clone']:
    assert '--detach' in args, 'clone must return on creation, not wait for template startup'
    name = args[args.index('--name') + 1]
    new_id = f'{len(machines) + 1:014x}'
    machines.append({'id': new_id, 'name': name, 'state': 'stopped',
                     'config': {'env': {'TEMPORAL_WORKER_SURFACE_HASH': 'old'}}})
    save()
    journal.write_text(journal.read_text() + 'clone\n')
    print(f'Machine {new_id} has been created...')
elif args[:2] == ['machine', 'update']:
    assert '--skip-start' in args and '--skip-health-checks' in args
    machine = next(m for m in machines if m['id'] == args[2])
    for pos, arg in enumerate(args):
        if arg == '--env':
            key, value = args[pos + 1].split('=', 1)
            machine['config']['env'][key] = value
    machine['state'] = 'stopped'
    save()
    journal.write_text(journal.read_text() + f'update {machine["id"]}\n')
elif args[:2] == ['machines', 'start']:
    machine = next(m for m in machines if m['id'] == args[2])
    machine['state'] = 'started'
    save()
else:
    raise AssertionError(args)
PY
chmod +x "$TMP/bin/"*

run_case() {
  local orphans="$1"
  local previous_hash="${2:-old}"
  python3 - "$TMP/state.json" "$orphans" "$previous_hash" <<'PY'
import json, sys
orphans = int(sys.argv[2])
previous_hash = sys.argv[3]
machines = [{'id': '00000000000001', 'name': 'old-template', 'state': 'started',
             'config': {'env': {'TEMPORAL_WORKER_SURFACE_HASH': 'old'}}}]
for i in range(orphans):
    machines.append({'id': f'{i + 2:014x}', 'name': f'gen-abc-previous-{i}',
                     'state': 'stopped',
                     'config': {'env': {'TEMPORAL_WORKER_SURFACE_HASH': previous_hash,
                                        'TEMPORAL_WORKER_DEPLOYMENT_TOKEN': 'earlier'}}})
open(sys.argv[1], 'w').write(json.dumps(machines))
PY
  : > "$TMP/journal"
  PATH="$TMP/bin:$PATH" FAKE_FLY_STATE="$TMP/state.json" \
    FAKE_FLY_JOURNAL="$TMP/journal" FLY_API_TOKEN=fake APP=test \
    SURFACE_HASH=abc GENERATION_QUEUE=navi-agent-tasks@abc \
    BUILD_ID=build DEPLOYMENT_TOKEN=token \
    bash "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" > "$TMP/output"
  python3 - "$TMP/state.json" "$TMP/journal" "$orphans" <<'PY'
import json, sys
machines = json.load(open(sys.argv[1]))
journal = open(sys.argv[2]).read()
orphans = int(sys.argv[3])
new = [m for m in machines if m['config']['env'].get('TEMPORAL_WORKER_SURFACE_HASH') == 'abc']
assert len(new) == 8 and all(m['state'] == 'started' for m in new), (len(new), new, journal)
assert journal.count('clone\n') == 8 - orphans, journal
assert journal.count('update ') == 8, journal
assert journal.count('flip\n') == 1, journal
PY
}

run_case 8 # retry adopts every clone created by a previous failed attempt
run_case 8 abc # retry restarts machines already updated to the target hash
run_case 0 # fresh rollout clones with --detach and configures every machine
echo 'PASS: cooperative Fly clone recovery and fresh generation provisioning'
