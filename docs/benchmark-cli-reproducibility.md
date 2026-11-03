# Benchmark operator CLI prerequisites

Run from the selected checkout as the same operating-system user that owns its
private operation inputs. A root-created mode0600 config cannot be consumed by
an unrelated unprivileged launcher. Do not chmod private credentials to make a
wrong-user invocation work, change HOME, or borrow another user's session.

Before creating a controller allocation intent, the canonical gate now runs:

```bash
python3 scripts/cloudbench-operator-preflight.py --require-flyctl
```

Select the installed Fly CLI in the launcher's PATH explicitly. The preflight
does not install it, guess a different user's installation, authenticate,
contact the provider, or allocate resources. Private operator inputs can be
checked under the intended launch UID before starting the external owner:

```bash
python3 scripts/cloudbench-operator-preflight.py \
  --require-flyctl --private-input "$CONFIG" --private-input "$AUTHORITY"
```

The gate itself checks CLI availability before token lookup, Git/network work,
or allocation intent. Refusal is exit78. Existing ambiguous create responses
still require exact reconciliation; a failed command or empty stdout alone is
not proof that no provider resource exists.

## Credential READ source is separate from local runtime configuration

Preserve the complete authoritative backend `.env` as a credential READ source.
Use `scripts/prepare-deploy-worktree.sh` to hydrate its selected source-workspace
links. Never overwrite that file with local coverage or benchmark database URLs.
Set local runtime database URLs in the child environment, covering all of
DATABASE_URL, DIRECT_URL, DIRECT_DATABASE_URL, DEMO_CACHE_DATABASE_URL (legacy FAST_MODE_CACHE_DATABASE_URL) and
BLACKBOX_TEST_DATABASE_URL as required by the canonical isolated stack.

`seed-local.ts` and `sync-andy-claude-tokens-from-prod.ts` share the READ-source
selector. An implicit loopback URL in the parsed source file is refused before
credential queries. An intentional local restored source or tunnel must be
selected explicitly through `SEED_REMOTE_DATABASE_URL`; that does not change the
runtime DATABASE_URL. The separate `--compute-tokens-only` mode retains its
required explicit `SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL` contract. No example
env, secret subset, or copied local-only env substitutes for the complete source.

## Browser dependencies

The normal stack startup checks the Python Playwright installation and the
frontend's own Node Playwright installation separately. Their Chromium revisions
can differ. Missing browser installations are repaired with the corresponding
installed package's CLI, then both are checked again before services start.
Do not delete one consumer's browser to make room for the other.

## Original600 persistence boundary

The original600 harness is versioned separately so its disposable controller,
ticket accounting and shared relay are not replaced with older main versions.
The portable operator commit is `c51755facce9e45afbc831f8b807ad6940fc313e`, with
immutable parent `b0fbd7742dde51446288c22601825a85981c1d0b`. Fetch the published
`fix/original600-portable-operator` branch, create a separate worktree at that
exact commit, and follow its `docs/original600-operator-cli.md`:

```bash
git fetch origin fix/original600-portable-operator
git worktree add --detach "$OPERATOR_CHECKOUT" c51755facce9e45afbc831f8b807ad6940fc313e
cd "$OPERATOR_CHECKOUT"
python3 scripts/run-original600-controller.py --help
```

The command takes explicit current-owner facts, complete env files, original
tasks, authentic warm metadata and state directory. Omitting `--run` checks
local prerequisites with zero provider calls. Adding `--run` owns fresh capacity
reads, configuration binding and the actual controller lifecycle. It needs no
previous operator's host `/tmp` scripts or attempt receipts. This portable
entrypoint has local fixture qualification, not actual original600 success
credit or permission to replay a separately owned live operation.

The operator preserves the actual stale-reconciliation mutation result. A no-op
cohort does not force an inventory refresh; a mutating winner seals one fresh
healthy inventory generation for its peers under the original deadline. The
public `--status --run-dir` command reads a bound run without changing its source.
An already running experiment retains its recorded commit until it terminates.

Archive-based cleanup targets only the current archive's sealed Machine IDs.
Unrelated active or stopped Machines remain untouched and are counted as
excluded; their presence does not block cleanup of the current run.

Standard-library Hub admission probes skip Python site-package initialization.
The actual Hub server and third-party consumers retain their normal interpreter
startup; port, process-birth and immutable owner checks are unchanged.

The live fleet aggregator now keeps one unbuffered Python process per existing
owner, reads fresh files on every tick and retains the original one-second delay
after each tick. It avoids repeatedly importing dependencies during startup;
publication, error recovery and exact owner termination remain covered.

Archived original600 runs can now be supplied with repeated `--archive-run`
arguments. The operator validates their complete ownership/export evidence,
reserves eligible stopped Machines under native leases, and then re-reads
organization capacity before counting those reservations. It preserves physical
Machine IDs, attached volumes, prior data and unresolved claims. Each reused
task receives a new isolated workspace generation; this is not a fresh physical
volume. `--reuse-exclude-machine` excludes a changed candidate explicitly.

If admission is interrupted, retain the printed state directory and use the
same inputs with `--resume-admission`. This retains the original experiment
clock, reconciles recorded effects without blindly replaying them, and refuses
to relaunch an already-bound controller. The public status projection preserves
confirmed infrastructure flags through cancellation while keeping physical
terminal-attempt statistics separate.

The pinned CLI also supports resuming a recorded finalizer probe failure and
the exact pre-provider cleanup credential refusal. Follow its documented
receipt-bound continuation commands; retain the original journals and caller.
Cleanup receives the credential from the explicitly bound complete env file.
Native observation keeps its original deadline while loading immutable I/O
helpers once, and status counts directly proven startup failures separately
from canonical infrastructure flags.

For a closed run with both used and untouched reservations, the explicit
`--parked-reservation-run` path validates each recoverable parked claim and
retains ambiguous records without capacity credit. The complete archive and
current native identity are required; the next admission still obtains new
leases and verifies capacity. Empty archived responses remain held. Payload
fragments retain the existing 6,200-byte request limit.
