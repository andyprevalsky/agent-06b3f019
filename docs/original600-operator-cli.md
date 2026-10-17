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
declared unlisted/destroying allowance (default1), requires at least601 slots,
and must be younger than270 seconds at binding. A later allocation admission
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
