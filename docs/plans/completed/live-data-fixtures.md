# Live Data Fixtures — composable prod-synced credentials for benchmarks

## Problem

Benchmarks that run `live` (non-simulated, non-synthetic) need **current**
prod-synced credentials to reach real third parties: compute tokens (claudeAuth
$0 path), browser cookies (authenticated site access), and browser passwords.

Today this is delivered by **imperative, per-task-name branching** in
`run_benchmark.py:run_single_task` (`if task.name in AMAZON_COOKIE_BOOTSTRAP_TASK_NAMES`,
`if task.name in PLAID_TRANSACTION_BENCHMARK_TASK_NAMES`, the unconditional
`_sync_compute_tokens()` at 4066, etc.). The declarative `environment.secrets`
and `environment.live_targets` fields in `tasks.json` are **pure metadata** —
`long_horizon._validate_environment` type-checks them as string lists and nothing
else ever reads them. Every new live-auth benchmark means another task-name
constant + `if` branch.

There is no declarative, composable way to say "this task needs live compute
tokens + amazon cookies", and no single **base live fixture** that all live tasks
inherit.

## The distinction to encode

`db_fixtures` (frozen) and live data are architecturally opposite:

| | `db_fixtures` (frozen) | **live_fixtures (new)** |
|---|---|---|
| Source | committed/frozen snapshot | pulled from **prod at runtime** |
| Freshness | must be *stable* (reproducible) | must be *current* (tokens/cookies expire) |
| Snapshot-able | yes (part of base image) | **no** — never freeze a live credential |
| WMH corpus | eligible | must be excluded (like sim bundles) |

## Design: a `live_fixtures` registry that composes onto the env

Mirror the existing `BASE_IMAGES` registry (`fixtures.py`) with a `LIVE_FIXTURES`
registry. Each named fixture knows how to sync itself from prod into the isolated
benchmark DB, right before the agent starts, every run.

### The `base` live fixture (default for all live tasks)

Every task inherits `live_fixtures: ["base"]` unless it declares otherwise —
exactly as `base_images` defaults to `victoria-prod-sync-v1`. The `base` fixture
pulls, fresh from prod into the isolated DB:

- **compute tokens** — `seed-local.ts --compute-tokens-only` (already run
  unconditionally at `run_benchmark.py:4066`; becomes the `base` fixture's first step)
- **browser cookies** — currently only refreshed at one-time `setup-db` or via
  per-realm bundle bootstrap; the `base` fixture makes them fresh every run
- **browser passwords + passkeys** — `seed-local.ts --credentials-only`
  (currently passwords+passkeys only, never called from the runner)

## Scope of changes

### 1. Backend: broaden `--credentials-only` to include cookies + browser context

`back-end/scripts/seed-local.ts` — `syncBrowserCredentials()` (line 92) currently
syncs **Browser Passwords + Passkey Credentials** only. Broaden it to also sync
**Cookies + Browser Context + LocalStorage/IndexedDB/Permissions/Cache origins**
(the same tables the full sync already covers at lines 234–290), so a single
`--credentials-only` invocation refreshes all live browser auth state. Extract the
shared table-sync bodies into helpers so the full-sync path and credentials-only
path call the same code (no duplication).

- New flag semantics: `--credentials-only` = cookies + browser context + storage
  origins + passwords + passkeys (everything a browser needs to be logged in).
- Full sync path unchanged in behavior (calls the same extracted helpers).

### 2. New registry: `agents/benchmarks/live_fixtures.py`

```python
@dataclass(frozen=True)
class LiveFixture:
    name: str
    description: str
    apply: Callable[["LiveFixtureContext"], dict]  # sync prod -> isolated DB, returns manifest
    local_only: bool = True        # refuse against a prod base_url
    requires_fresh: bool = True    # re-sync every run; never trust a snapshot

DEFAULT_LIVE_FIXTURE = "base"

LIVE_FIXTURES: dict[str, LiveFixture] = {
    "base": LiveFixture(
        name="base",
        description="Live prod-synced compute tokens + browser cookies + passwords.",
        apply=_apply_base_live_fixture,   # compute-tokens-only THEN credentials-only
    ),
    "amazon_auth": LiveFixture(
        name="amazon_auth",
        description="Active CookieBundle for amazon.com from synced prod cookies.",
        apply=_apply_amazon_auth,         # wraps _ensure_local_cookie_bundle_for_realm
    ),
}
```

`LiveFixtureContext` carries `base_url`, `user_id`, and per-fixture params
(e.g. `auth_realm`). The `apply` callables are the **existing** injection
functions moved behind a common signature — a refactor of code that already
works, not new logic:

- `_apply_base_live_fixture` → `_sync_compute_tokens()` + broadened credentials sync
- `_apply_amazon_auth` → `_ensure_local_cookie_bundle_for_realm()`

### 3. Schema: add `live_fixtures` to the `environment` contract

- `agents/benchmarks/benchmark_tasks.py:_default_environment()` — add
  `"live_fixtures": [DEFAULT_LIVE_FIXTURE]`.
- `_load_tasks()` — inherit `["base"]` when a declared environment omits
  `live_fixtures` (mirror the `base_images` default-injection at line 126-127).
- Additive + back-compat: tasks that don't mention it get `["base"]`.

### 4. Validation: `long_horizon.py:_validate_environment`

- Add `live_fixtures` to the string-list fields.
- Every name in `live_fixtures` must exist in `LIVE_FIXTURES` (import the registry;
  fail catalog validation on unknown fixture).
- `mode: "synthetic"` must not declare live fixtures other than `[]`
  (live creds make no sense for a fully synthetic task).
- Keep the existing `mode: live` ⇒ no `db_fixtures` rule.

### 5. Dispatch: replace hardcoded task-name branches in `run_single_task`

Replace the scattered `if task.name in ...` credential/token blocks
(`run_benchmark.py:4002-4067`) with one loop over the declared fixtures:

```python
for fx_name in task.environment.get("live_fixtures", []):
    fx = LIVE_FIXTURES[fx_name]
    if fx.local_only and not _is_local_base_url(base_url):
        raise RuntimeError(f"{task.name}: live_fixture {fx_name} requires local stack")
    manifest = fx.apply(ctx)
```

- The unconditional `_sync_compute_tokens()` is subsumed by the `base` fixture,
  which every live task inherits — behavior preserved.
- Migrate `AMAZON_COOKIE_BOOTSTRAP_TASK_NAMES` tasks to declare
  `"live_fixtures": ["base", "amazon_auth"]`; delete the constant + branch.
- Leave `db_fixtures`-style frozen fixtures (Plaid, user-data, grep) as-is for now
  — they are a separate, already-working mechanism; this plan is scoped to *live*
  credentials.

### 6. WMH corpus hygiene

Ensure live-fixture manifests are recorded in the run's archive manifest and that
runs carrying live fixtures are excluded from the WMH trace corpus (same rule as
sim bundles / cache replays — see `[[project_sim_fastcache_scoping_rag_hygiene]]`).

## Files touched

- `back-end/scripts/seed-local.ts` — broaden `--credentials-only` (cookies + context)
- `agents/benchmarks/live_fixtures.py` — **new** registry
- `agents/benchmarks/benchmark_tasks.py` — default + inherit `live_fixtures`
- `agents/benchmarks/long_horizon.py` — validate `live_fixtures`
- `agents/benchmarks/run_benchmark.py` — registry dispatch replaces task-name branches
- `agents/benchmarks/tasks.json` — migrate amazon/live tasks to declare fixtures
- `agents/benchmarks/README.md` — document the live-fixture layer

## Automated verification

1. **Catalog validation** (`long_horizon.validate_catalog()`):
   - Add a unit test asserting an unknown `live_fixtures` name fails validation.
   - Assert every task with `mode: live` resolves to a non-empty `live_fixtures`
     (defaulting to `["base"]`), and `synthetic` tasks resolve to `[]`.
   - Assert `_load_tasks()` injects `["base"]` for tasks omitting the key.
2. **Backend blackbox** (`back-end/src/tests/blackbox/`):
   - Test that `seed-local.ts --credentials-only` upserts Cookies + BrowserContext
     + BrowserPassword rows into a scratch DB (extend existing seed-local coverage;
     do NOT hand-roll a curl — run through the blackbox harness per CLAUDE.md #17).
3. **Live smoke** (`browser-agent` task via `scripts/run-bench browser-agent`):
   - Run the amazon task after migrating it to `["base", "amazon_auth"]`; assert
     the agent reaches an authenticated Amazon state and the `actual_model` is a
     `claude-*` family (compute-token path hit, per
     `[[feedback_gemini_means_claude_failed]]`). Include the FE link and verify it
     renders the agent.
4. **Full eval suite** (`run_eval_suite.py --port N`) after the change to confirm
   no `ready` task regressed on env resolution.

## Approval notes

- Adds one key (`live_fixtures`) to the `tasks.json` `environment` contract —
  additive, defaults to `["base"]`, back-compat. Approved by user 2026-07-06.
- No changes to any task's pass criteria, timeouts, prompts, or load sizes
  (no reward hacking — CLAUDE.md #24).
