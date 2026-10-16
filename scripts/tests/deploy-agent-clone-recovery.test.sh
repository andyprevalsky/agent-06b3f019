#!/usr/bin/env bash
# Exercise the real cutover script with Fly/npm/Prisma fakes. A Fly clone may
# exist even when the first deploy command timed out waiting for it to start.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
REAL_PYTHON="$(command -v python3)"

# Execute the real helper with only its HTTP boundary backed by the same native
# Machine fixture as fake flyctl. There is no provider request or extra owner.
cat > "$TMP/bin/python3" <<PY
#!$REAL_PYTHON
import importlib.util, json, os, sys
from pathlib import Path
from urllib.error import URLError
if len(sys.argv) < 2 or Path(sys.argv[1]).name != 'retained_agent_machine.py':
    os.execv('$REAL_PYTHON', ['$REAL_PYTHON', *sys.argv[1:]])
source = Path(sys.argv[1])
action = sys.argv[2]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
helper = load('actual_pool_helper', source)
fixture = load('pool_http_fixture', source.parent / 'tests/retained-agent-machine.test.py')
state = Path(os.environ['FAKE_FLY_STATE'])
journal = Path(os.environ['FAKE_FLY_JOURNAL'])
native = None
def http(request, timeout):
    global native
    rows = json.loads(state.read_text())
    if native is None:
        mid = request.full_url.split('/machines/')[1].split('/')[0]
        native = fixture.NativeHTTP(next(row for row in rows if row['id'] == mid), app='test', token='fake')
    failure = state.parent / 'activate-failures'
    if (action == 'activate' and request.method == 'POST' and '/metadata/' in request.full_url
            and failure.exists() and int(failure.read_text()) > 0):
        failure.write_text(str(int(failure.read_text()) - 1))
        raise URLError('fixture metadata failure after native rolling deploy')
    if (action == 'reuse' and request.method == 'POST'
            and request.full_url.endswith('/' + os.environ.get('FAKE_FLY_POOL_FAIL_ID', 'never'))):
        raise URLError('fixture retained update refused')
    try:
        result = native(request, timeout)
        if request.method == 'POST' and request.full_url.endswith('/' + native.machine['id']):
            journal.write_text(journal.read_text() + 'pool-update ' + native.machine['id'] + '\\n')
        if '/metadata/' in request.full_url:
            journal.write_text(journal.read_text() + 'pool-retire ' + native.machine['id'] + '\\n')
        return result
    finally:
        rows = [native.machine if row['id'] == native.machine['id'] else row for row in rows]
        state.write_text(json.dumps(rows))
helper.urlopen = http
sys.argv = sys.argv[1:]
helper.main()
PY

cat > "$TMP/bin/npm" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat > "$TMP/bin/npx" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == *'set-agent-queue-pointer.ts --read'* ]]; then
  if [ -n "${FAKE_FLY_POINTER_HASH:-}" ]; then
    printf '{"surfaceHash":"%s","taskQueue":"navi-agent-tasks@%s"}\n' "$FAKE_FLY_POINTER_HASH" "$FAKE_FLY_POINTER_HASH"
  else
    echo null
  fi
elif [[ "$*" == *'set-agent-queue-pointer.ts --queue'* ]]; then
  echo flip >> "$FAKE_FLY_JOURNAL"
elif [[ "$*" == *'retire-agent-queue.ts'* ]]; then
  printf 'admission %s\n' "$*" >> "$FAKE_FLY_JOURNAL"
  if [[ "$*" == *'--retire'* ]] && [ "${FAKE_FLY_ADMISSION_UNKNOWN:-0}" = 1 ]; then exit 7; fi
elif [[ "$*" == *'count-open-workflows-on-queue.ts'* ]]; then
  if [ "$PWD" != "$FAKE_FLY_BACKEND_DIR" ]; then
    echo counter-cwd-refused >> "$FAKE_FLY_JOURNAL"
    echo 'FAIL: native queue counter must run from back-end' >&2
    exit 8
  fi
  echo "${FAKE_FLY_OPEN_COUNT:-0}"
  exit "${FAKE_FLY_OPEN_STATUS:-0}"
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
    journal.write_text(journal.read_text() + ('local-build\n' if '--local-only' in args else 'remote-build\n'))
    if '--build-only' not in args:
        # Model the native selection contract: an unscoped app deploy also
        # updates stopped Machines; explicit IDs limit its target set.
        selected = set(args[args.index('--only-machines') + 1].split(',')) if '--only-machines' in args else {m['id'] for m in machines}
        if '--only-machines' in args:
            assert '--update-only' in args and '--ha=false' in args
            assert args[args.index('--strategy') + 1] == 'rolling'
        for machine in machines:
            if machine['id'] not in selected:
                continue
            for pos, arg in enumerate(args):
                if arg == '--env':
                    key, value = args[pos + 1].split('=', 1)
                    machine['config']['env'][key] = value
            machine['config']['image'] = 'registry.fly.io/test:rolling'
            machine['state'] = 'started'
            machine['instance_id'] = 'rolling-' + machine['id']
            journal.write_text(journal.read_text() + 'rolling ' + machine['id'] + '\n')
            partial = path.parent / 'rolling-failures'
            if partial.exists() and int(partial.read_text()) > 0:
                partial.write_text(str(int(partial.read_text()) - 1))
                save()
                sys.exit(1)
        save()
    print('image: registry.fly.io/test:cutover-abc-token')
elif args[:2] == ['machines', 'list']:
    list_failures = Path(os.environ['FAKE_FLY_LIST_FAILURES'])
    remaining = int(list_failures.read_text())
    if remaining > 0 and 'start-refused' in journal.read_text():
        list_failures.write_text(str(remaining - 1))
        journal.write_text(journal.read_text() + 'list-failed\n')
        print('Error: failed to list machines: request returned non-2xx status: 503', file=sys.stderr)
        sys.exit(1)
    print(json.dumps(machines))
elif args[:2] == ['machine', 'clone']:
    if os.environ.get('FAKE_FLY_NO_CREATE') == '1':
        journal.write_text(journal.read_text() + 'create-refused\n')
        sys.exit(1)
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
    failures = Path(os.environ['FAKE_FLY_UPDATE_FAILURES'])
    remaining = int(failures.read_text())
    if remaining > 0:
        failures.write_text(str(remaining - 1))
        journal.write_text(journal.read_text() + 'update-408\n')
        print(f'Error: could not update machine {args[2]}: failed to update VM {args[2]}: '
              'request returned non-2xx status: 408:  (Request ID: fake-iad)', file=sys.stderr)
        sys.exit(1)
    machine = next(m for m in machines if m['id'] == args[2])
    for pos, arg in enumerate(args):
        if arg == '--env':
            key, value = args[pos + 1].split('=', 1)
            machine['config']['env'][key] = value
        if arg == '--metadata':
            key, value = args[pos + 1].split('=', 1)
            machine['config'].setdefault('metadata', {})[key] = value
    machine['state'] = 'stopped'
    save()
    journal.write_text(journal.read_text() + f'update {machine["id"]}\n')
elif args[:2] == ['machines', 'stop']:
    if args[2] == os.environ.get('FAKE_FLY_STOP_FAILURE_ID'):
        journal.write_text(journal.read_text() + 'stop-refused\n')
        sys.exit(1)
    next(m for m in machines if m['id'] == args[2])['state'] = 'stopped'
    save()
    journal.write_text(journal.read_text() + f'stop {args[2]}\n')
elif args[:2] == ['machines', 'destroy']:
    machines = [m for m in machines if m['id'] != args[2]]
    save()
    journal.write_text(journal.read_text() + f'destroy {args[2]}\n')
elif args[:2] == ['machines', 'start']:
    refusals = Path(os.environ['FAKE_FLY_START_REFUSALS'])
    remaining = int(refusals.read_text())
    if remaining > 0:
        refusals.write_text(str(remaining - 1))
        journal.write_text(journal.read_text() + 'start-refused\n')
        print(f'Error: could not start machine {args[2]}: failed to start VM {args[2]}: '
              'failed_precondition: machine getting replaced, refusing to start '
              '(Request ID: fake-iad)', file=sys.stderr)
        sys.exit(1)
    machine = next(m for m in machines if m['id'] == args[2])
    machine['state'] = 'started'
    save()
    journal.write_text(journal.read_text() + f'start {machine["id"]}\n')
else:
    raise AssertionError(args)
PY
chmod +x "$TMP/bin/"*

seed_state() {
  local orphans="$1"
  local previous_hash="$2"
  printf '%s' "$3" > "$TMP/update-failures"
  printf '%s' "${4:-0}" > "$TMP/start-refusals"
  printf '%s' "${5:-0}" > "$TMP/list-failures"
  printf 0 > "$TMP/activate-failures"
  printf 0 > "$TMP/rolling-failures"
  python3 - "$TMP/state.json" "$orphans" "$previous_hash" <<'PY'
import json, sys
orphans = int(sys.argv[2])
previous_hash = sys.argv[3]
machines = [{'id': '00000000000001', 'name': 'old-template', 'state': 'started',
             'instance_id': 'native-old',
             'config': {'env': {'TEMPORAL_WORKER_SURFACE_HASH': 'old',
                                'TEMPORAL_WORKER_BUILD_ID': 'old-build',
                                'TEMPORAL_WORKER_DEPLOYMENT_TOKEN': 'old-attempt'}}}]
for i in range(orphans):
    machines.append({'id': f'{i + 2:014x}', 'name': f'gen-abc-previous-{i}',
                     'state': 'stopped',
                     'instance_id': f'native-spare-{i}',
                     'config': {'env': {'TEMPORAL_WORKER_SURFACE_HASH': previous_hash,
                                        'TEMPORAL_WORKER_DEPLOYMENT_TOKEN': 'earlier'}}})
open(sys.argv[1], 'w').write(json.dumps(machines))
PY
  : > "$TMP/journal"
}

run_cutover() {
  PATH="$TMP/bin:$PATH" FAKE_FLY_STATE="$TMP/state.json" \
    FAKE_FLY_BACKEND_DIR="$ROOT/back-end" \
    FAKE_FLY_JOURNAL="$TMP/journal" FAKE_FLY_UPDATE_FAILURES="$TMP/update-failures" \
    FAKE_FLY_START_REFUSALS="$TMP/start-refusals" \
    FAKE_FLY_LIST_FAILURES="$TMP/list-failures" \
    FLY_API_TOKEN=fake APP=test \
    DEPLOY_REUSE_ONLY="${FAKE_FLY_REUSE_ONLY:-1}" \
    SURFACE_HASH=abc GENERATION_QUEUE=navi-agent-tasks@abc \
    BUILD_ID=build DEPLOYMENT_TOKEN="${FAKE_FLY_DEPLOYMENT_TOKEN:-token}" \
    bash "$ROOT/scripts/deploy-agents-cooperative-cutover.sh" > "$TMP/output" 2>&1
}

seed_released_spares() {
  seed_state 8 abc 0
  "$REAL_PYTHON" - "$ROOT" "$TMP/state.json" <<'PY'
import copy, importlib.util, json, sys
from pathlib import Path
source = Path(sys.argv[1]) / 'scripts/retained_agent_machine.py'
spec = importlib.util.spec_from_file_location('pool', source)
pool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pool)
rows = json.load(open(sys.argv[2]))
for row in rows[1:]:
    row['name'] = 'immutable-retired-' + row['id']
    row['config'].update(image='registry.fly.io/test:previous', mounts=[{'volume':'vol-'+row['id'], 'path':'/evidence'}])
    row['config']['env'].update(TEMPORAL_WORKER_SURFACE_HASH='spare', TEMPORAL_WORKER_BUILD_ID='spare-build', TEMPORAL_WORKER_DEPLOYMENT_TOKEN='spare-attempt')
    row['config']['metadata'] = {}
    source_record = pool.record(row, 'test')
    custody = {key: source_record[key] for key in ('app', 'id', 'instance_id', 'config_sha256')}
    custody.update(version=1, rootfs_disposition='archived', evidence_ref='https://evidence.example/native-spare')
    row['config']['metadata'][pool.CUSTODY_KEY] = json.dumps(custody)
    marker = dict(version=1, phase='idle', source=source_record, drained_queue='navi-agent-tasks@spare', retired_by=dict(build='retiring-build',token='retiring-attempt'))
    row['config']['metadata'][pool.POOL_KEY] = json.dumps(marker)
open(sys.argv[2], 'w').write(json.dumps(rows))
PY
}

# Visibility zero cannot override the actual durable admission owner.
seed_state 8 abc 0
export FAKE_FLY_POINTER_HASH=old FAKE_FLY_NO_CREATE=1 FAKE_FLY_ADMISSION_UNKNOWN=1
if run_cutover; then echo 'FAIL: unknown admission coverage permitted retirement' >&2; exit 1; fi
grep -q 'admission .*--begin' "$TMP/journal" || { echo 'FAIL: admission was never closed' >&2; exit 1; }
grep -q 'admission .*--retire' "$TMP/journal" || { echo 'FAIL: exact readiness owner was bypassed' >&2; exit 1; }
if grep -qE '^stop |^destroy |^pool-retire ' "$TMP/journal"; then echo 'FAIL: unqualified membership stopped/released workers' >&2; exit 1; fi
unset FAKE_FLY_POINTER_HASH FAKE_FLY_NO_CREATE FAKE_FLY_ADMISSION_UNKNOWN
echo 'PASS: unknown durable admission coverage preserves old workers despite visibility zero'

case "${1:-all}" in all|retention|reuse|idle-name|cwd|rolling|reuse-only) ;; *) echo 'Unknown test selection' >&2; exit 2 ;; esac
if [ "${1:-all}" = all ] || [ "${1:-all}" = reuse-only ]; then
  for source_case in empty partial update_failure; do
    seed_released_spares
    if [ "$source_case" != update_failure ]; then
      "$REAL_PYTHON" - "$TMP/state.json" "$source_case" <<'PY'
import copy,json,sys
p=sys.argv[1]; rows=json.load(open(p)); keep=1 if sys.argv[2]=='empty' else 5
if sys.argv[2]=='empty':
 rows=rows[:1]
 for index in range(7):
  row=copy.deepcopy(rows[0]); row.update(id=f'{100+index:014x}',instance_id=f'old-live-{index}',name=f'old-live-{index}')
  rows.append(row)
 keep=len(rows)
open(p,'w').write(json.dumps(rows[:keep]))
PY
    else
      export FAKE_FLY_POOL_FAIL_ID=00000000000003
    fi
    cp "$TMP/state.json" "$TMP/before-reuse-only.json"
    export FAKE_FLY_POINTER_HASH=old
    result=0
    run_cutover || result=$?
    "$REAL_PYTHON" - "$TMP/state.json" "$TMP/before-reuse-only.json" "$TMP/journal" "$source_case" "$result" <<'PY'
import json,sys
after=json.load(open(sys.argv[1]));before=json.load(open(sys.argv[2]));journal=open(sys.argv[3]).read();mode=sys.argv[4]
assert 'clone\n' not in journal and 'create-refused' not in journal, ('reuse-only attempted fresh allocation',mode,journal)
assert 'local-build\n' in journal and 'remote-build\n' not in journal, ('reuse-only must not request a Fly remote builder',mode,journal)
assert {r['id'] for r in after}=={r['id'] for r in before},(mode,journal)
assert int(sys.argv[5])!=0 and 'flip\n' not in journal and 'stop ' not in journal and 'destroy ' not in journal,(mode,journal)
assert after[0]==before[0], 'live old worker/data must remain intact'
if mode=='empty': assert after==before and len(after)==8
else:
 if mode=='partial': assert journal.count('pool-update ')==4,journal
 if mode=='update_failure': assert journal.count('pool-update ')==1,journal
 for row in after[1:]:
  assert row['config']['mounts']==[{'volume':'vol-'+row['id'],'path':'/evidence'}]
PY
    unset FAKE_FLY_POINTER_HASH FAKE_FLY_POOL_FAIL_ID
  done
  echo 'PASS: reuse-only forbids fresh creation after empty, partial or failed reuse'
  if [ "${1:-all}" = reuse-only ]; then exit 0; fi
fi
if [ "${1:-all}" = all ] || [ "${1:-all}" = rolling ]; then
  for rolling_case in success undersized metadata_failure partial_failure; do
    live_count=8
    if [ "$rolling_case" = undersized ]; then live_count=7; fi
    seed_released_spares
    "$REAL_PYTHON" - "$TMP/state.json" "$live_count" <<'PY'
import copy,json,sys
p=sys.argv[1]; rows=json.load(open(p)); live=[]
for i in range(int(sys.argv[2])):
 row=copy.deepcopy(rows[0]); row.update(id=f'{100+i:014x}', instance_id=f'live-{i}', name=f'live-{i}',state='started')
 row['config']['env'].update(TEMPORAL_WORKER_SURFACE_HASH='abc',TEMPORAL_WORKER_BUILD_ID='previous-build',TEMPORAL_WORKER_DEPLOYMENT_TOKEN='previous-attempt')
 if i%2:
  row['config']['metadata']={'rose_cooperative_worker_pool':json.dumps(dict(version=1,phase='active',app='test',id=row['id'],hash='abc',build='previous-build',token='previous-attempt'))}
 live.append(row)
# Idle pool with the live hash/immutable target name is still excluded.
rows[1]['name']='gen-abc-retired'; rows[1]['config']['env']['TEMPORAL_WORKER_SURFACE_HASH']='abc'
rows[2]['state']='started'; rows[2]['config']['env']['TEMPORAL_WORKER_SURFACE_HASH']='abc'
rows[2]['config']['metadata']['rose_worker_reuse_protected']='true'
open(p,'w').write(json.dumps(rows+live))
PY
    cp "$TMP/state.json" "$TMP/before-rolling.json"
    export FAKE_FLY_POINTER_HASH=abc FAKE_FLY_NO_CREATE=1
    if [ "$rolling_case" = metadata_failure ] || [ "$rolling_case" = partial_failure ]; then
      if [ "$rolling_case" = metadata_failure ]; then printf 1 > "$TMP/activate-failures"; else printf 1 > "$TMP/rolling-failures"; fi
      if run_cutover; then echo 'FAIL: injected rolling failure was not reported' >&2; exit 1; fi
      export FAKE_FLY_DEPLOYMENT_TOKEN=recovery-attempt
    fi
    if [ "$live_count" = 8 ]; then
      run_cutover || { cat "$TMP/output" >&2; echo 'FAIL: scoped same-hash rolling exited' >&2; exit 1; }
    else
      if run_cutover; then echo 'FAIL: undersized live fleet admitted rolling update' >&2; exit 1; fi
    fi
    "$REAL_PYTHON" - "$TMP/state.json" "$TMP/before-rolling.json" "$TMP/journal" "$live_count" "${FAKE_FLY_DEPLOYMENT_TOKEN:-token}" <<'PY'
import json,sys
after=json.load(open(sys.argv[1])); before=json.load(open(sys.argv[2])); journal=open(sys.argv[3]).read(); count=int(sys.argv[4])
assert after[:9]==before[:9], 'same-hash deploy consumed retained/protected/foreign Machines'
if count==8:
 assert len(after)==len(before) and journal.count('rolling ')>=8, journal
 assert {line.split()[1] for line in journal.splitlines() if line.startswith('rolling ')}=={row['id'] for row in after[9:]},journal
 for row in after[9:]:
  assert row['state']=='started' and row['config']['env']['TEMPORAL_WORKER_DEPLOYMENT_TOKEN']==sys.argv[5]
  marker=json.loads(row['config']['metadata']['rose_cooperative_worker_pool'])
  assert marker['phase']=='active' and marker['build']=='build' and marker['token']==sys.argv[5] and 'rolling' not in marker
else:
 assert after==before and not journal, (after,journal)
assert 'clone\n' not in journal and 'destroy ' not in journal and 'flip\n' not in journal,journal
PY
    unset FAKE_FLY_POINTER_HASH FAKE_FLY_NO_CREATE FAKE_FLY_DEPLOYMENT_TOKEN
  done
  echo 'PASS: same-hash rolling deployment touches only the owned live fleet and retains idle pool'
  if [ "${1:-all}" = rolling ]; then exit 0; fi
fi
if [ "${1:-all}" != reuse ] && [ "${1:-all}" != idle-name ] && [ "${1:-all}" != cwd ]; then
  seed_state 8 abc 0
  export FAKE_FLY_POINTER_HASH=old FAKE_FLY_NO_CREATE=1
  run_cutover || { cat "$TMP/output" >&2; echo 'FAIL: stop-retain cutover exited' >&2; exit 1; }
  "$REAL_PYTHON" - "$TMP/state.json" "$TMP/journal" <<'PY'
import json,sys
rows=json.load(open(sys.argv[1])); journal=open(sys.argv[2]).read()
assert len(rows)==9 and 'destroy ' not in journal, ('drained Machine must be retained', rows, journal)
old=next(row for row in rows if row['id']=='00000000000001')
assert old['state']=='stopped'
assert json.loads(old['config']['metadata']['rose_cooperative_worker_pool'])['phase']=='idle'
assert 'flip\n' in journal and journal.index('flip\n')<journal.index('stop '),journal
print('PASS: drained old Machine is confirmed stopped and retained after pointer publication')
PY
  unset FAKE_FLY_POINTER_HASH FAKE_FLY_NO_CREATE
  if [ "${1:-all}" = retention ]; then exit 0; fi
fi

# A retained generation can have a name matching a later rollback target.
# That immutable name must never bypass the custody/lease path.
if [ "${1:-all}" != cwd ]; then
for target_fields in previous current; do
seed_released_spares
export FAKE_FLY_POINTER_HASH=old FAKE_FLY_NO_CREATE=1
"$REAL_PYTHON" - "$TMP/state.json" "$target_fields" <<'PY'
import json,sys
p=sys.argv[1]; rows=json.load(open(p))
for row in rows[1:]:
 row['name']='gen-abc-retired-'+row['id']
 row['config']['metadata'].pop('rose_worker_reuse_custody')
 if sys.argv[2]=='current':
  row['config']['env'].update(TEMPORAL_WORKER_SURFACE_HASH='abc', TEMPORAL_WORKER_BUILD_ID='build', TEMPORAL_WORKER_DEPLOYMENT_TOKEN='token')
open(p,'w').write(json.dumps(rows))
PY
if run_cutover; then echo 'FAIL: retired immutable name bypassed custody' >&2; exit 1; fi
if grep -qE '^update |pool-update |^flip$|^stop |^start |destroy ' "$TMP/journal"; then
  echo 'FAIL: unproved retired data was consumed by name' >&2; exit 1
fi
unset FAKE_FLY_POINTER_HASH FAKE_FLY_NO_CREATE
done
fi
if [ "${1:-all}" = idle-name ]; then exit 0; fi

# Existing live-generation workers stay until all eight released spares start;
# the old Machine is stopped and retained, never destroyed.
seed_released_spares
export FAKE_FLY_POINTER_HASH=old FAKE_FLY_NO_CREATE=1
run_cutover || { cat "$TMP/output" >&2; echo 'FAIL: released same-app reuse exited' >&2; exit 1; }
"$REAL_PYTHON" - "$TMP/state.json" "$TMP/journal" <<'PY'
import json, sys
rows=json.load(open(sys.argv[1])); journal=open(sys.argv[2]).read()
assert len(rows)==9 and 'create-refused' not in journal and 'clone\n' not in journal and 'destroy ' not in journal, journal
new=[m for m in rows if m['config']['env'].get('TEMPORAL_WORKER_SURFACE_HASH')=='abc']
assert len(new)==8 and all(m['state']=='started' for m in new), rows
assert all(m['config']['mounts']==[{'volume':'vol-'+m['id'],'path':'/evidence'}] for m in new)
old=next(m for m in rows if m['id']=='00000000000001')
assert old['state']=='stopped'
assert json.loads(old['config']['metadata']['rose_cooperative_worker_pool'])['phase']=='idle'
assert journal.count('pool-update ')==8 and journal.count('pool-retire ')==1 and journal.count('flip\n')==1,journal
PY
if [ "${1:-all}" = cwd ]; then exit 0; fi

# Replaying with a new attempt refreshes the retained IDs' actual provenance;
# immutable old names cannot cause another clone or retain an earlier token.
"$REAL_PYTHON" - "$TMP/state.json" <<'PY'
import json,sys
p=sys.argv[1]; rows=json.load(open(p))
for row in rows:
 if row['config']['env']['TEMPORAL_WORKER_SURFACE_HASH']=='abc': row['state']='stopped'
open(p,'w').write(json.dumps(rows))
PY
export FAKE_FLY_DEPLOYMENT_TOKEN=second-attempt
run_cutover || { cat "$TMP/output" >&2; echo 'FAIL: reuse continuation exited' >&2; exit 1; }
"$REAL_PYTHON" - "$TMP/state.json" <<'PY'
import json,sys
for row in json.load(open(sys.argv[1])):
 if row['config']['env']['TEMPORAL_WORKER_SURFACE_HASH']=='abc':
  assert row['config']['env']['TEMPORAL_WORKER_DEPLOYMENT_TOKEN']=='second-attempt'
  assert json.loads(row['config']['metadata']['rose_cooperative_worker_pool'])['token']=='second-attempt'
PY
unset FAKE_FLY_DEPLOYMENT_TOKEN

# A foreign build/attempt sharing the target hash cannot satisfy healthy MIN8
# and cannot be adopted through an unrelated immutable name or marker.
seed_state 8 abc 0
"$REAL_PYTHON" - "$TMP/state.json" <<'PY'
import json,sys
p=sys.argv[1]; rows=json.load(open(p))
for row in rows[1:]:
 row['name']='foreign-'+row['id']; row['state']='started'
 row['config']['env'].update(TEMPORAL_WORKER_BUILD_ID='foreign-build', TEMPORAL_WORKER_DEPLOYMENT_TOKEN='foreign-token')
open(p,'w').write(json.dumps(rows))
PY
if run_cutover; then echo 'FAIL: foreign attempt satisfied healthy MIN8' >&2; exit 1; fi
if grep -qE '^flip$|^stop |^update |pool-update ' "$TMP/journal"; then
  echo 'FAIL: foreign attempt caused adoption or publication' >&2; exit 1
fi

# A busy or unreadable historical queue cannot release its stopped Machines.
for source_status in busy unknown; do
  seed_released_spares
  if [ "$source_status" = busy ]; then
    export FAKE_FLY_OPEN_COUNT=1 FAKE_FLY_OPEN_STATUS=0
  else
    export FAKE_FLY_OPEN_COUNT=0 FAKE_FLY_OPEN_STATUS=1
  fi
  if run_cutover; then echo 'FAIL: unsafe historical queue was reused' >&2; exit 1; fi
  if grep -qE 'pool-update |^flip$|^stop |destroy ' "$TMP/journal"; then
    echo 'FAIL: busy/unknown source caused an unsafe mutation' >&2; exit 1
  fi
done
unset FAKE_FLY_OPEN_COUNT FAKE_FLY_OPEN_STATUS

# A failed stop is not credited as retirement or converted into destruction.
seed_state 8 abc 0
"$REAL_PYTHON" - "$TMP/state.json" <<'PY'
import copy,json,sys
p=sys.argv[1]; rows=json.load(open(p)); other=copy.deepcopy(rows[0])
other.update(id='000000000000ff', name='another-old-worker', instance_id='another-native-version')
rows.append(other)
open(p,'w').write(json.dumps(rows))
PY
export FAKE_FLY_STOP_FAILURE_ID=00000000000001
if run_cutover; then echo 'FAIL: unconfirmed old stop passed' >&2; exit 1; fi
grep -q 'stop-refused' "$TMP/journal" || { cat "$TMP/output" >&2; exit 1; }
if grep -qE 'destroy |pool-retire 00000000000001' "$TMP/journal"; then echo 'FAIL: uncertified retirement mutated metadata/destroyed ID' >&2; exit 1; fi
grep -q 'pool-retire 000000000000ff' "$TMP/journal" || { echo 'FAIL: one refused stop prevented independent idle cleanup' >&2; exit 1; }
unset FAKE_FLY_STOP_FAILURE_ID FAKE_FLY_POINTER_HASH FAKE_FLY_NO_CREATE

# A protected old worker remains untouched even after the old queue drained.
seed_state 8 abc 0
"$REAL_PYTHON" - "$TMP/state.json" <<'PY'
import json,sys
p=sys.argv[1]; rows=json.load(open(p))
rows[0]['config']['metadata']={'rose_worker_reuse_protected':'true'}
open(p,'w').write(json.dumps(rows))
PY
export FAKE_FLY_POINTER_HASH=old FAKE_FLY_NO_CREATE=1
if run_cutover; then echo 'FAIL: protected old worker was silently retired' >&2; exit 1; fi
if grep -qE '^stop |destroy |pool-retire ' "$TMP/journal"; then
  echo 'FAIL: protected old worker was touched' >&2; exit 1
fi
unset FAKE_FLY_POINTER_HASH FAKE_FLY_NO_CREATE

run_case() {
  local orphans="$1"
  local update_failures="${3:-0}"
  local start_refusals="${4:-0}"
  local list_failures="${5:-0}"
  seed_state "$orphans" "${2:-old}" "$update_failures" "$start_refusals" "$list_failures"
  FAKE_FLY_REUSE_ONLY=0 run_cutover || { cat "$TMP/output" >&2; echo "FAIL: cutover exited non-zero" >&2; exit 1; }
  python3 - "$TMP/state.json" "$TMP/journal" "$orphans" "$update_failures" <<'PY'
import json, sys
machines = json.load(open(sys.argv[1]))
journal = open(sys.argv[2]).read()
orphans = int(sys.argv[3])
update_failures = int(sys.argv[4])
new = [m for m in machines if m['config']['env'].get('TEMPORAL_WORKER_SURFACE_HASH') == 'abc']
assert len(new) == 8 and all(m['state'] == 'started' for m in new), (len(new), new, journal)
assert len(machines) == 9, ('a retried update must not clone extra machines', machines)
assert journal.count('clone\n') == 8 - orphans, journal
assert journal.count('update ') == 8, journal
assert journal.count('update-408\n') == update_failures, journal
assert journal.count('flip\n') == 1, journal
PY
}

run_case 8 # retry adopts every clone created by a previous failed attempt
run_case 8 abc # retry restarts machines already updated to the target hash
run_case 0 # fresh rollout clones with --detach and configures every machine
run_case 0 old 2 # Fly Machines API 408s on update are retried in-run, not fatal
run_case 0 old 0 4 # starts refused while Fly is still replacing the VM are re-issued
run_case 8 abc 0 4 # adopted clones refused at start are re-issued too
run_case 0 old 0 4 2 # a transient machines-list failure while waiting is retried, not fatal

# Surplus target-generation clones: only the machines needed to reach MIN start.
seed_state 9 abc 0 9
run_cutover || { cat "$TMP/output" >&2; echo "FAIL: surplus cutover exited non-zero" >&2; exit 1; }
python3 - "$TMP/state.json" "$TMP/journal" <<'PY'
import json, sys
machines = json.load(open(sys.argv[1]))
journal = open(sys.argv[2]).read()
new = [m for m in machines if m['config']['env'].get('TEMPORAL_WORKER_SURFACE_HASH') == 'abc']
assert len(new) == 9, new
assert sum(m['state'] == 'started' for m in new) == 8, (new, journal)
assert journal.count('flip\n') == 1, journal
PY

seed_state 0 old 4
if FAKE_FLY_REUSE_ONLY=0 run_cutover; then
  echo "FAIL: cutover succeeded although every machine update attempt failed" >&2
  exit 1
fi
grep -q 'failed after 4 attempts' "$TMP/output" ||
  { cat "$TMP/output" >&2; echo "FAIL: exhausted update retries were not reported" >&2; exit 1; }
if grep -q '^flip$' "$TMP/journal"; then
  echo "FAIL: queue pointer flipped although a new-generation machine never configured" >&2
  exit 1
fi
echo 'PASS: cooperative Fly clone recovery and fresh generation provisioning'
