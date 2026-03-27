---
description: "Discover a backend domain and build the strongest practical test safety net for safe autonomous refactors. Iterate until tests exist, pass, and fail on deliberate regressions."
argument-hint: "<domain-name> [optional hints]"
---

# Create Domain Blackbox Tests

Create and stabilize the strongest practical test safety net for a backend domain. Discover the surface from the repo, add missing tests, and keep iterating until the suite is green, stable, and proven to fail on deliberate regressions.

If `$ARGUMENTS` is empty, ask the user for the domain and stop.

**This is a loop. Do NOT stop after analysis, planning, or partial implementation. Continue until the validation gates pass or you are blocked by a true ambiguity that cannot be resolved from the codebase.**

## Inputs

- Required: `$ARGUMENTS` must contain the domain name, module, folder, bounded context, or feature name.
- Treat any extra text in `$ARGUMENTS` as optional hints.
- If the user does not provide route prefixes, source globs, test commands, or dependency details, discover them from the repo.

## Non-negotiable rules

- Test only observable behavior.
- Do not assert internal implementation details such as call counts or “function X was called” unless X is an external boundary.
- Prefer real boundary behavior over raw mocks.
- For deterministic request/response third-party boundaries, prefer typed adapters backed by `@with-logic/fast-forward` or an equivalent record/replay harness.
- Use raw mocks only when the boundary is destructive, unsafe, too costly to hit live, requires rare fault injection, or is not meaningfully record/replayable.
- Assert behavior through public entrypoints and externally visible effects:
  - response or handler outputs
  - persisted state changes
  - emitted events, jobs, or messages
  - outbound calls at system boundaries
- Keep tests deterministic, isolated, cleanup-safe, and parallel-safe.
- Use unique test data and avoid shared mutable fixtures.
- Reuse existing test patterns, helpers, and fixtures when possible.
- Prefer minimal supporting test utilities over production code changes.
- Leave unrelated user changes in the worktree untouched.
- Every contract run must emit a run-scoped artifact directory under `.context/test-runs/<run-id>/`.
- Every run must record an agent-readable manifest of ports, URLs, log paths, and mutable resources used by the suite.

## Required discovery

Identify all relevant public entrypoints for the domain, including any relevant:
- HTTP routes
- background jobs or workers
- event consumers or producers
- scheduled tasks
- CLI or admin handlers
- other cross-module public interfaces if there is no transport boundary

Build a behavior map before adding tests:
- entrypoint
- input shapes and auth rules
- happy path outputs
- failure modes
- state changes
- async side effects
- external boundaries

## Required coverage

### 1. Contract coverage for every public entrypoint

Cover all relevant cases:
- authentication and authorization
- validation and malformed input handling
- happy path behavior
- not-found behavior
- forbidden behavior
- conflict, idempotency, retry, or rate-limit behavior
- stable output semantics, including status codes, shape, and business meaning

### 2. Characterization coverage for representative workflows

Capture end-to-end observable outputs for normal and edge workflows. Assert:
- direct output
- state delta
- emitted async side effects
- external boundary interactions

### 3. Invariant coverage

Include every relevant invariant below. If one is not relevant, explicitly document why it is not applicable.

- auth boundary invariant
- error-surface invariant
- idempotency or retry invariant for mutating flows
- read-after-write consistency invariant
- concurrency invariant
- state transition invariant
- ordering or pagination invariant
- atomicity invariant
- referential integrity invariant
- event or job cardinality invariant
- duplication prevention invariant
- permission or tenant isolation invariant where relevant
- harness independence invariant: unrelated background jobs and sidecars do not affect the suite
- cleanup invariant: the suite does not leak ports, processes, temp dirs, or mutable resources
- observability invariant: every failing run points at the correct run-scoped logs and manifest
- time or clock invariant where timestamp behavior matters
- same-input reproducibility invariant

### 4. Flake resistance

- Run the new domain-focused suite repeatedly at least 5 times.
- Fix nondeterminism until stable.
- Ensure the domain suite itself executes its test cases in parallel, with a default intra-domain concurrency of `30` unless the repo proves a lower safe ceiling is required.
- Treat this as a real execution default, not a recommendation: when running a single domain, the suite must actually execute with case concurrency `30` by default unless explicitly justified otherwise.
- Run at least 2 concurrent invocations of the same domain suite and ensure both pass without interference.
- Ensure it can run concurrently with other suites.

## Naming

- Use `contract` only for narrow wire-level interface checks such as status codes, schemas, and protocol compatibility.
- For the broader safety-net suite described by this command, prefer `blackbox` as the primary name because it encodes the non-negotiable rule: assert observable behavior only, not internals.
- Preferred file template for a domain suite: `<domain>.blackbox.ts`
- Preferred folder name for new repos or deliberate migrations: `src/tests/blackbox/`
- `behavior` is acceptable only if the repo is already standardized on it. Do not introduce `behavior`, `blackbox`, and `contract` side by side.
- If the repo already has an established `contracts/` or `behavior/` convention, do not mix ad hoc names. Either:
  - keep the existing pattern for consistency
  - or do a deliberate repo-wide migration to `blackbox`
- In reports, distinguish:
  - `contract coverage` for schema and protocol assertions
  - `black-box coverage` for the full safety net

## Execution loop

### Step 1: Discover the domain surface

Find the domain source files, public entrypoints, test locations, existing coverage, runtime dependencies, and the narrowest reliable test command for this domain.

Before writing tests, discover the resource topology from the repo:
- `conductor.json`
- run scripts
- env files and runtime config
- local sidecars or emulators
- external boundaries

Produce a resource manifest for the run that includes:
- allocated ports
- spawned services
- cache or artifact directories
- mutable shared resources and how they are namespaced
- log file locations

If focused commands are not obvious:
1. Reuse an existing domain-specific test command if one already exists.
2. Otherwise derive the narrowest reliable test invocation from the repo's existing test runner.
3. For a single-domain run, ensure the default invocation preserves intra-domain case concurrency `30`.
4. Do not confuse top-level runner concurrency with intra-domain concurrency: `domainConcurrency=1` is acceptable only if the domain suite itself still runs its cases in parallel.
5. Also identify a broader relevant suite to run before declaring success.

### Step 2: Build the coverage matrix

Create a working matrix that maps:
- entrypoint -> required scenarios -> test file
- invariant -> test file

Use the matrix to identify gaps before writing code.

### Step 3: Implement missing tests

Add or update tests to close the gaps. Prefer black-box and boundary-level assertions. If minimal test helpers or fixtures are needed, add them.

If the domain touches third-party boundaries:
- use record/replay adapters instead of raw mocks where appropriate
- document any boundary where record/replay is not applicable and explain why

### Step 4: Run and fix

Run the focused domain suite. Fix failing tests, test bugs, or missing harness issues. Repeat until green.

Do not stop at the first green run. Keep going through the remaining steps.

### Step 5: Parallel and flake test

Run the focused domain suite at least 5 times. Fix any nondeterminism and rerun until all repetitions are clean.

Also prove concurrency:
1. Run the same domain suite in at least 2 concurrent processes with isolated resources.
2. Verify the single-domain suite itself executes its cases in parallel, defaulting to `30` workers.
3. Verify from logs or harness output that the single-domain run actually used case concurrency `30` by default.
4. Fix shared-state assumptions, log collisions, or resource-allocation races until all concurrency conditions hold.

### Step 6: Negative-control checks

Make at least 3 temporary, local, non-committed behavior-breaking changes across meaningful behaviors in the domain. For each one:
1. Confirm the new tests fail for the correct reason.
2. Revert the temporary change.

Use realistic perturbations such as:
- wrong status or error mapping
- missing or duplicated side effect
- broken state transition
- auth bypass or auth over-restriction
- ordering, pagination, or idempotency regression

### Step 7: Final verification

Run:
- the focused domain suite
- the broader relevant existing suite

Only finish after both are green.

## Validation gates

Do not declare success unless all of these are true:
- the new domain suite passes
- existing relevant tests still pass
- the single-domain suite executes its cases in parallel with default intra-domain concurrency `30` unless explicitly justified otherwise
- the reported evidence distinguishes intra-domain case concurrency from top-level domain-process concurrency
- concurrent invocations of the same domain suite pass without interference
- every discovered public entrypoint is either covered by tests or explicitly listed as residual risk with justification
- every skipped invariant is justified
- negative-control checks proved the new tests fail when behavior is intentionally broken
- the final restored code is green again

## Final response

Report:
- what domain surface was discovered
- the resource manifest and artifact directory path
- the exact single-domain command and the evidence that it used case concurrency `30` by default
- which test files were added or updated
- the coverage matrix:
  - entrypoint -> test cases
  - invariant -> test file
- exact commands run and the result of each
- whether fast-forward or an equivalent replay harness was used for each relevant third-party boundary, or why it was not applicable
- residual risks and unobservable areas

Only say:
`Domain safety net ready for autonomous refactoring`

if every validation gate passed.

Otherwise say:
`Domain safety net not ready for autonomous refactoring`

and list the blockers.
