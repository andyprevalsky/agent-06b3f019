# Versioned original600 operator

Use this harness lineage, whose immutable parent is
`b0fbd7742dde51446288c22601825a85981c1d0b`. Do not substitute an older main
`run-bench` implementation or cherry-pick this lineage's unrelated backend over
current production. Checkout the published **operator commit**, not a floating
branch tip; that exact commit is also the controller's fetched source reference.

This public CLI replaces the historical private capacity reader, config binder
and external-owner script. All host inputs and output locations are explicit.
Guest `/tmp/gate/repo` paths are the existing controller mount contract, not a
dependency on a previous operator's host `/tmp` files. No original attempt or
receipt is copied forward as a new result.

## Inputs and ownership

Run as the selected ordinary operator UID, with that user's authenticated,
installed Fly CLI v0.4.115 on PATH. Other versions refuse before provider reads;
the observed JSON organization alias contract is pinned to this operator version.
Keep HOME unchanged. The state directory must be
physical, owned by that UID, mode0700. All input files must be physical,
single-link, same-UID, mode0600. A wrong-UID root/private file must not be made
world-readable; provision complete inputs for the intended operator instead.

Supply the complete authoritative agents and backend env files, the authentic
selected warm snapshot inventory and dependency fingerprint, and a private facts
JSON containing `app`, digest-pinned `image_ref`, `protected_machines` and
`protected_volumes`. The app is fixed to `navi-whisper-lux-bench`. Preserve the
existing protected resource cohort; never invent IDs to satisfy admission.

The exact original ordered200 task manifest is committed at
`scripts/tests/fixtures/original600-tasks.json`. Copy its exact bytes to a private
input file, e.g. `install -m600 scripts/tests/fixtures/original600-tasks.json "$TASKS"`.
The runner verifies the original ordered names hash and pins task source
`570830dbf17635e13d16a6f03b4d705f6b6443b1`. No task selection, prompt, evaluator,
concurrency, retry or timeout override exists in this wrapper.

## One command

First omit `--run` for local source, UID, credential-input and CLI checks with
zero provider calls. Then use the identical command with `--run` to read fresh
organization capacity, bind a new operation and own its controller to closure:

```bash
python3 scripts/run-original600-controller.py \
  --source-ref "$EXACT_OPERATOR_COMMIT" \
  --state-dir "$PRIVATE_STATE_DIRECTORY" \
  --facts "$PRIVATE_FACTS_JSON" \
  --agents-env "$COMPLETE_AGENTS_ENV" \
  --backend-env "$COMPLETE_BACKEND_ENV" \
  --tasks "$TASKS" \
  --snapshot-inventory "$AUTHENTIC_SNAPSHOT_INVENTORY" \
  --warm-deps "$AUTHENTIC_DEPENDENCY_FINGERPRINT" \
  --run
```

No secret is printed or passed as a command argument. The CLI token comes from
the selected agents file. Capacity reads use the requested organization
(default `personal`), a fresh complete app list and every app's native Machine
inventory. The read phase retains the original110-second bound, without
background worker threads that could outlive a drip-fed response. Capacity is
not atomic; the proof says so. It conservatively subtracts the separately
declared unlisted/destroying allowance (default1), requires at least601 new
slots without archived reuse, and must be younger than270 seconds at binding. A later allocation admission
still rechecks the existing canonical authority. No quota is increased.

The controller remains performance-8x/32768MiB with a256GiB workspace. The actual
benchmark remains200 tasks ×3 repeats,600 concurrency, one infrastructure retry,
1200-second tasks and the original5400-second campaign clock. The7200-second
host watchdog covers bootstrap/export/cleanup and does not extend task clocks.
Complete environment bytes are sent only to this new controller, without
changing app secrets.

The printed new state directory contains the original capacity reads, immutable
config/authority, caller identities, gate log and eventual terminal receipt.
Keep the CLI alive through cancellation and cleanup. Its existing native
supervisor protocol signals only its exact owner and retains ambiguous creation,
writer or export states. A failed create is not proof of no effect; do not
fabricate resource ownership or cleanup receipts. Successful exit alone is not
an original600 success: inspect the canonical600 outcomes and unique-infra count.
Local offline fixture passes do not qualify actual capacity, R2 publication,
provider allocation or the five-consecutive-run goal.


### Reuse preserved Machines from completed controller archives

To reuse the preserved Machines of prior interrupted runs, add one
`--archive-run` for each original run directory to the same command above:

```bash
  --archive-run "$PREVIOUS_RUN_DIRECTORY_1" \
  --archive-run "$PREVIOUS_RUN_DIRECTORY_2" \
  --reuse-exclude-machine "$OPTIONAL_CHANGED_MACHINE_ID"
```

The exclusion flag is optional and repeatable. For example, exclude a Machine
whose current instance changed during a separately recorded capability probe;
an old inventory must not substitute for its new ownership evidence. Supply the
complete original run directories with their verified controller export,
terminal and cleanup records, not a list of Machine IDs. Keep those directories
and their private original artifacts available. Missing or conflicting evidence
refuses reuse; do not edit old receipts to make them match.

Without `--run`, this is still a local source/input check with no provider
calls. With `--run`, the CLI reads fresh capacity and verifies archived ownership,
protected resources, stopped state, instance, configuration and attached Volume.
An eligible stopped Machine is not free quota. Only an exclusive, durably
recorded native reservation that has been read back can reduce new allocation
demand. With R such reservations, the unchanged600-task campaign needs
`601 - R` new Machine slots, including its controller. Existing objects remain
in the organization's measured total. All qualified candidates are considered
before creating fresh Machines; protected or unproven candidates receive no
credit.

Reused Machines keep their IDs, names and attached physical Volumes. The storage
mode is explicitly `retained-volume-fresh-generation`, not a newly created
Volume. A new exclusive generation directory is mounted over `/data` in a
private mount namespace before the ordinary boot, status server and task
processes start. The previous Volume contents remain outside that task view.
The immutable guest helper checks the generation, owner, namespace and source
bindings. External runtime commands enter that same verified namespace; file
collection resolves the matching generation rather than old `/data` artifacts.
An unavailable isolation primitive or stale binding stops admission before task
execution.

This changes storage reuse, not the original ordered tasks, three repetitions,
600 concurrency, retry budget or execution limits. Old claims, unresolved prior
outcomes and data are retained. Cleanup stops a reused Machine and archives its
current ownership; it does not delete its Machine or Volume or convert an old
failure into a success. A later reuse must prove the latest archived owner and
current native marker, so an older archive cannot reclaim a newer generation.

Retain the CLI's reservation intents, raw responses and readback receipts if an
operation is interrupted. A missing response is an unknown effect, not evidence
that nothing happened. To resume admission, use the same command and all its
original inputs with `--resume-admission "$PRINTED_ADMISSION_DIRECTORY"`.
The CLI verifies the source and input hashes, keeps the first admission's
5400-second clock, and reconciles the same cohort and journals. An ambiguous
operation is never blindly repeated. Once a controller launch is recorded,
this option refuses a second launch; use the printed run directory with
`--status` and keep its existing owner. Never remove an intent, bypass a claim,
or select a new output directory merely to retry an ambiguous operation.

### Launcher credentials and no-effect failures

Both complete `--backend-env` and `--agents-env` inputs are resolved explicitly,
so a sparse harness checkout does not need copied `.env` files. CHECK resolves a
literal GitHub credential using the existing controller precedence (explicit
base64 override, Git credential rewrite, local gh login, process token, selected
complete backend then agents file) before any capacity read or allocation. It
never prints credentials. Only the owned gate receives the selected token in its
process environment; no whole environment/DB variables or secret subset files
are copied and no token is serialized into the launch config.

If the joined gate explicitly refuses a missing GitHub credential before any
export/allocation stage, it writes a private typed preallocation receipt. The
runner binds its exact gate PID, source, reason and exit status, requires the
entire export path to be absent, then records `FAILED_BEFORE_PROVIDER_DISPATCH`
and joins. Missing ownership/intent files or a generic failed gate alone never
prove no effect: ambiguous CREATE/export/provider failures keep their original
live cleanup owner and pending evidence. This terminal classification does not
retroactively relabel an older launch or benchmark outcome.


### Read one bound status observation

From a checkout containing this public helper, use either form:

```bash
python3 scripts/run-original600-controller.py --status --run-dir "$RUN_DIR"
# Equivalent standalone entry point:
python3 scripts/original600-status.py --run-dir "$RUN_DIR"
```

The command defaults to the adjacent `config.private.json`, the complete agents
input path/SHA256 already bound by `authority.private.json`, and a new private
observation file in the run directory. Optional `--config`, `--agents-env` and
`--out-dir` accept explicit physical paths; the selected complete agents bytes
must still match the original authority. A separate output directory must
already exist, be private and belong to the current user. No `.env` file is
required in the source checkout. Keep the selected authenticated `flyctl` on
PATH for canonical session refresh; credentials are never printed.

Run/config/caller/authority/controller/source/epoch bindings are checked before
one bounded read-only guest exec. It uses the exact supervisor-derived campaign
summary path, not a directory scan. Guest Python runs with `-S` because this
payload is entirely standard library. The command cannot signal, cancel,
restart, stop or delete anything. Only its local private observation is written.
An original local terminal or unpublished controller returns without a provider
call. An unpublished supervisor/summary is reported explicitly; transport,
identity, malformed-data or freshness uncertainty never becomes a fake result.

Canonical infra counts deduplicate only terminal attempts with an explicit true
infra flag. Terminal attempts with missing/null infra classification are counted
separately as unknown, as are failed jobs without a terminal attempt. A zero
confirmed-infra count never means those unknown jobs were error free. Attempt-record counts are separate from completed attempts;
local terminal and status output never infer benchmark success or full resource
cleanup. This is a one-shot diagnostic, not an automatic threshold owner or
five-experiment qualification loop.
