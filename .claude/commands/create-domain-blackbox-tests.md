---
description: "Discover a backend domain and build the strongest practical test safety net for safe autonomous refactors. Iterate until tests exist, pass, and fail on deliberate regressions."
argument-hint: "<domain-name> [optional hints]"
---

# Create Domain Blackbox Tests

Create and stabilize the strongest practical test safety net for a backend domain. Discover the surface from the repo, add missing tests, and keep iterating until the suite is green, stable, and proven to fail on deliberate regressions.

If `$ARGUMENTS` is empty, ask the user for the domain and stop.

**This is a loop. Do NOT stop after analysis, planning, or partial implementation. Continue until the validation gates pass or you are blocked by a true ambiguity that cannot be resolved from the codebase.**

## Step 0: Verify and bootstrap required infrastructure

This skill requires three pieces of infrastructure. Check if each exists; if not, build it.

```bash
find . -maxdepth 3 -name 'map-domains.*' -o -name 'map_domains.*' | grep -v node_modules | grep -v __pycache__
find . -maxdepth 4 -name 'fetchCapture.*' -o -name 'fetch_capture.*' -o -name 'httpx_capture.*' | grep -v node_modules | grep -v __pycache__
find . -maxdepth 3 -name 'run-blackbox-tests.*' -o -name 'run_blackbox_tests.*' | grep -v node_modules | grep -v __pycache__
```

### 0a. Domain mapping script

**If missing:** Run `/map-domains` first. It will analyze this codebase, define the domains, and write the mapping script. Do NOT proceed without it.

### 0b. Outbound HTTP capture harness

**If it exists:** skip to 0c.

**If missing:** build it. Read the reference implementation at `back-end/src/providers/fetchCapture.ts` and the article at `.context/attachments/pasted_text_2026-04-05_20-13-11.txt` to understand the design, then write a capture harness for this codebase's language and HTTP client.

The capture harness must:

1. **Intercept outbound HTTP calls** — Wrap the runtime's HTTP client (e.g., `globalThis.fetch` for JS, `httpx` for Python, `net/http` for Go) to record every outbound call. Filter out localhost/loopback calls to avoid infinite recursion if the harness itself makes HTTP calls.

2. **Activate via environment variable** — Only intercept when `BLACKBOX_TEST_CAPTURE_OUTBOUND=1` is set. In normal operation, the harness must be completely transparent (zero overhead).

3. **Record per-call data** — For each intercepted call, store:
   - `id` (incrementing integer)
   - `timestamp` (ISO 8601)
   - `url` (full URL)
   - `method` (GET, POST, etc.)
   - `requestHeaders` (redact Authorization/API key values for security)
   - `requestBody` (string or null)
   - `responseStatus` (integer or null if error)
   - `responseBody` (truncated to ~2000 chars)
   - `durationMs` (wall-clock time)
   - `error` (string or null)
   - `cached` (boolean — true if served from replay cache)

4. **Expose a test API** — Provide a way for tests to read and clear captures:
   - For HTTP servers: mount endpoints (e.g., `GET /api/test/captures`, `DELETE /api/test/captures`)
   - For non-HTTP codebases (agents, CLIs, libraries): expose a Python/JS module with `get_captures()`, `clear_captures()` functions that tests import directly

5. **Support response caching (optional but recommended)** — On first run, make real API calls and cache responses. On subsequent runs, replay from cache. This makes tests fast and deterministic without mocking. The reference uses `@with-logic/fast-forward`; Python equivalents include `vcrpy`, `responses`, or `respx`.

6. **Isolate between tests** — Clear captures must reset the in-memory log so each test starts with a clean capture buffer. Cache clearing should be separate (delete filesystem cache to force re-record).

**Where to put it:** In the codebase's shared infrastructure directory (e.g., `providers/`, `helpers/`, `lib/`, `test_utils/`). Name it `fetch_capture.*` or `httpx_capture.*` matching the HTTP client being wrapped.

**Verification:** After writing the harness, write a minimal smoke test that:
1. Activates capture mode
2. Makes an outbound HTTP call
3. Reads captures and asserts the call was recorded with correct URL, method, and body
4. Clears captures and asserts the buffer is empty

### 0c. Blackbox test runner

**If it exists:** skip to Step 1.

**If missing:** build it. Read the reference implementation at `back-end/scripts/run-blackbox-tests.sh` to understand the design, then write a runner for this codebase.

The test runner must:

1. **Generate a unique run ID** — Timestamp + PID or UUID. All artifacts for this run live under a single directory.

2. **Create an artifact directory** — At `.context/test-runs/<run-id>/`. Store logs, manifests, and any test-generated files here.

3. **Write a manifest file** — `manifest.json` in the artifact directory with:
   - `run_id`
   - `mode` (isolated or existing service)
   - `base_url` (if applicable)
   - `port` (if applicable)
   - `artifact_dir` path
   - any other runtime config (env vars, feature flags)

4. **Start the service in test mode (if applicable)** — For HTTP servers: reserve a port, start the server with `BLACKBOX_TEST_CAPTURE_OUTBOUND=1`, wait for health check. For non-HTTP codebases (agents, CLIs, libraries): set up the test environment (env vars, temp dirs, capture mode activation).

5. **Support an existing-service mode** — If `BLACKBOX_TEST_USE_EXISTING_SERVICE=1` is set, skip service launch and use `TEST_BASE_URL` directly. This allows running against a service already started by Conductor or manually.

6. **Run the test suite** — Invoke the codebase's test runner (pytest, jest, go test, etc.) with:
   - Domain filtering (run only tests for the specified domain)
   - Output to both stdout and `<artifact-dir>/runner.log`
   - Exit code propagation (test failures = non-zero exit)

7. **Clean up on exit** — Kill spawned processes, release port locks, clean temp files. Use signal traps to clean up even on SIGINT/SIGTERM.

8. **Support `--list` mode** — List available test domains without running anything.

**Where to put it:** `scripts/run_blackbox_tests.sh` (or `.py` if the codebase prefers Python scripts).

**Verification:** After writing the runner:
1. Run with `--list` and verify it lists domains
2. Run against a trivial passing test and verify the artifact directory is created with manifest.json
3. Verify cleanup works (no orphaned processes or port locks after exit)

## Inputs

- Required: `$ARGUMENTS` must contain the domain name, module, folder, bounded context, or feature name.
- Treat any extra text in `$ARGUMENTS` as optional hints.
- If the user does not provide route prefixes, source globs, test commands, or dependency details, discover them from the repo.

## Non-negotiable rules

- Test only observable behavior.
- Do not assert internal implementation details such as call counts or "function X was called" unless X is an external boundary.
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

### 3. Boundary capture coverage

**Every domain that touches third-party services MUST capture and assert on the exact outbound HTTP calls made by the backend.** This is not optional — it is how we ensure production parity.

The repo provides a fetch capture harness (`back-end/src/providers/fetchCapture.ts`) that wraps `globalThis.fetch` and records all outbound HTTP calls when `BLACKBOX_TEST_CAPTURE_OUTBOUND=1`. The blackbox test runner (`scripts/run-blackbox-tests.sh`) enables this automatically.

For each third-party boundary discovered during the behavior map:
1. **Run the real request** — send a real HTTP request that triggers the outbound call. Use test credentials, seed DB state, or use validation-passing inputs as needed.
2. **Clear captures** before each boundary test: `DELETE /api/test/captures`
3. **Read captures** after the request: `GET /api/test/captures`
4. **Assert on the captured call** with exact parameter matching:
   - URL pattern (e.g., `https://verify.twilio.com/v2/Services/{SID}/Verifications`)
   - HTTP method
   - Request headers (Content-Type, auth scheme)
   - Request body params (exact key-value pairs)
   - Call ordering (when multiple outbound calls are expected)

**Important constraints:**
- Boundary tests MUST run sequentially (not in the parallel pool) because the capture buffer is shared global state.
- If the third-party service rate-limits or returns errors, still assert on the captured call params — the parameters sent are the contract, not the response received.
- If the third-party credentials are not configured (e.g., Twilio not set up), skip the boundary test with a clear log message — do not fail.
- For fire-and-forget async boundaries (e.g., SMS sent after response), add a short delay (~500ms) before reading captures to allow the async call to complete.
- Validation failures that short-circuit before any outbound call should also be tested as boundary tests: assert that 0 outbound calls were made.

**DB state seeding:** If a boundary test requires specific DB state (e.g., a user with a phone number, a subscription), seed it using existing API endpoints or the internal API key. Document what state was seeded and why.

### 4. Invariant coverage

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
- **boundary param invariant**: exact params sent to third-party APIs match the expected contract
- **call ordering invariant**: when a request triggers multiple outbound calls, they happen in the expected order

### 5. Flake resistance

- Run the new domain-focused suite repeatedly at least 5 times.
- Fix nondeterminism until stable.
- Ensure the domain suite itself executes its test cases in parallel, with a default intra-domain concurrency of `30` unless the repo proves a lower safe ceiling is required.
- Treat this as a real execution default, not a recommendation: when running a single domain, the suite must actually execute with case concurrency `30` by default unless explicitly justified otherwise.
- Run at least 2 concurrent invocations of the same domain suite and ensure both pass without interference.
- Ensure it can run concurrently with other suites.
- Boundary tests that hit real third-party APIs must handle rate-limit and transient error responses gracefully — assert on the captured call params, not on the third-party response status.

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
  - `boundary coverage` for third-party call capture assertions

## Execution loop

### Step 1: Discover the domain surface

Find the domain source files, public entrypoints, test locations, existing coverage, runtime dependencies, and the narrowest reliable test command for this domain.

Before writing tests, discover the resource topology from the repo:
- `conductor.json`
- run scripts
- env files and runtime config
- local sidecars or emulators
- external boundaries

**For external boundaries, trace every `fetch()` call in the domain source to identify:**
- The third-party service URL pattern
- The HTTP method and content type
- The request body structure (JSON fields, URL-encoded params, etc.)
- The auth mechanism (Basic, Bearer, API key header)
- Whether the call is synchronous (awaited before response) or fire-and-forget (async after response)

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
- **third-party boundary -> captured call assertions -> test file**

Use the matrix to identify gaps before writing code. Every third-party boundary must have at least one capture test.

### Step 3: Implement missing tests

Add or update tests to close the gaps. Prefer black-box and boundary-level assertions. If minimal test helpers or fixtures are needed, add them.

If the domain touches third-party boundaries:
- **Use the fetch capture harness** (`/api/test/captures` endpoints) to capture and assert on outbound HTTP calls
- Run real requests that trigger the outbound calls, using test credentials or seeded DB state
- Assert on exact URL, method, headers, and body params of captured calls
- Assert on call ordering when multiple outbound calls are expected
- Handle rate-limit and transient errors gracefully in assertions
- Document any boundary where capture is not applicable and explain why

If a boundary test requires DB state that doesn't exist:
- Seed it using existing API endpoints (e.g., create anonymous session, use internal API key)
- If no existing endpoint can create the needed state, create it via a test-only setup helper
- Document what state was seeded and why in the test file

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
- **wrong third-party API params** (e.g., wrong URL path, missing body field, wrong content type)

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
- **every third-party boundary has at least one capture test, or is explicitly listed with justification for why capture is not applicable**
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
  - **third-party boundary -> capture test (with captured URL, method, and param summary)**
- exact commands run and the result of each
- whether fast-forward or an equivalent replay harness was used for each relevant third-party boundary, or why it was not applicable
- **for each boundary capture test: the exact captured URL pattern, method, content-type, and body param keys that are asserted on**
- residual risks and unobservable areas

Only say:
`Domain safety net ready for autonomous refactoring`

if every validation gate passed.

Otherwise say:
`Domain safety net not ready for autonomous refactoring`

and list the blockers.
