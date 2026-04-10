---
description: "Discover a domain and build the strongest practical test safety net for safe autonomous refactors. Works for backend (HTTP/API), frontend (React/Vue/Svelte SPA), and non-HTTP codebases."
argument-hint: "<domain-name> [optional hints]"
---

# Create Domain Blackbox Tests

Create and stabilize the strongest practical test safety net for a domain. Discover the surface from the repo, add missing tests, and keep iterating until the suite is green, stable, and proven to fail on deliberate regressions.

If `$ARGUMENTS` is empty, ask the user for the domain and stop.

**This is a loop. Do NOT stop after analysis, planning, or partial implementation. Continue until the validation gates pass or you are blocked by a true ambiguity that cannot be resolved from the codebase.**

## Step 0: Verify and bootstrap required infrastructure

This skill requires three pieces of infrastructure. Check if each exists; if not, build it.

```bash
find . -maxdepth 3 -name 'map-domains.*' -o -name 'map_domains.*' | grep -v node_modules | grep -v __pycache__
find . -maxdepth 4 -name 'fetchCapture.*' -o -name 'fetch_capture.*' -o -name 'httpx_capture.*' | grep -v node_modules | grep -v __pycache__
find . -maxdepth 4 -name 'msw-server.*' -o -name 'mswServer.*' -o -name 'msw-handlers.*' -o -name 'setupTests.*' | grep -v node_modules | grep -v __pycache__
find . -maxdepth 3 -name 'run-blackbox-tests.*' -o -name 'run_blackbox_tests.*' | grep -v node_modules | grep -v __pycache__
```

### Codebase type detection

Before proceeding, detect whether this is a backend or frontend codebase. This determines which infrastructure is required and which testing model to use.

```bash
cat package.json 2>/dev/null | head -50
ls src/pages/ src/app/ src/routes/ src/features/ 2>/dev/null
ls src/domains/ src/routes/ src/handlers/ src/tools/ 2>/dev/null
```

| Signal | Codebase type |
|---|---|
| `react`, `vue`, `svelte`, `@angular/core` in dependencies | **Frontend SPA** |
| `next`, `nuxt`, `sveltekit`, `remix` in dependencies | **Frontend SSR/hybrid** (test client-rendered parts as frontend, SSR routes as backend) |
| `express`, `fastify`, `flask`, `django`, `gin` in dependencies | **Backend HTTP server** |
| `pages/`, `app/`, `features/` directories with `.tsx`/`.vue`/`.svelte` files | **Frontend** |
| `routes/`, `domains/`, `handlers/` directories with route definitions | **Backend** |
| None of the above (agent, CLI, library) | **Non-HTTP** — use the existing non-HTTP guidance |

Set a mental label: **FRONTEND** or **BACKEND** (or **HYBRID** for SSR frameworks). Use this label throughout all subsequent steps to choose the correct infrastructure, discovery, and assertion model.

### 0a. Domain mapping script

**If missing:** Run `/map-domains` first. It will analyze this codebase, define the domains, and write the mapping script. Do NOT proceed without it.

### 0b. Boundary capture harness

**If it exists:** skip to 0c.

The capture harness records outbound calls at system boundaries so tests can assert on them. The implementation differs for backend vs. frontend.

#### Backend: Outbound HTTP capture harness (fetchCapture / httpx_capture)

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

#### Frontend: MSW (Mock Service Worker) capture harness

MSW is the frontend equivalent of fetchCapture — it intercepts `fetch` calls in the jsdom/happy-dom test environment and lets tests assert on what API calls the UI made.

**If missing:** build it. The MSW harness must:

1. **Install MSW for the test environment** — Use `msw/node` (not the browser service worker). Add `msw` as a dev dependency.

2. **Create a shared handler file** — `src/tests/blackbox/msw/handlers.ts` (or `msw/handlers.ts` in the test directory). Define default handlers that return realistic responses for every API endpoint the frontend calls. These are the "happy path" defaults — individual tests override specific handlers when testing edge cases.

3. **Create a server setup file** — `src/tests/blackbox/msw/server.ts`:
   ```ts
   import { setupServer } from 'msw/node'
   import { handlers } from './handlers'
   export const server = setupServer(...handlers)
   ```

4. **Create a request capture module** — `src/tests/blackbox/msw/capture.ts`:
   - Export a `capturedRequests` array that records every request MSW intercepts
   - Record: `url`, `method`, `headers`, `body` (parsed JSON or raw text), `timestamp`
   - Export `clearCaptures()` to reset between tests
   - Install capture via a lifecycle event: `server.events.on('request:start', ...)` or a passthrough handler that records before forwarding to the matched handler

5. **Create a test setup file** — `src/tests/blackbox/setup.ts` (referenced by vitest.config `setupFiles`):
   ```ts
   import { server } from './msw/server'
   import { clearCaptures } from './msw/capture'
   beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
   afterEach(() => { server.resetHandlers(); clearCaptures() })
   afterAll(() => server.close())
   ```

6. **Configure `onUnhandledRequest: 'error'`** — This is critical. Any API call not handled by MSW causes the test to fail immediately. This prevents tests from silently passing when the component makes unexpected API calls or when a handler is missing.

7. **Isolate between tests** — `server.resetHandlers()` + `clearCaptures()` in `afterEach`. Each test starts with only the default handlers and an empty capture buffer.

**Where to put it:** `src/tests/blackbox/msw/` directory with `handlers.ts`, `server.ts`, and `capture.ts`.

**Verification:** After writing the harness:
1. Write a trivial test that renders a component making an API call
2. Assert the MSW handler returned the expected response
3. Assert the capture recorded the correct URL, method, and body
4. Assert `clearCaptures()` empties the buffer
5. Assert that an unhandled request causes a test failure (`onUnhandledRequest: 'error'`)

#### Frontend: Test wrapper with providers

Most frontend components require context providers (auth, router, theme, data) to render. Create a shared test wrapper:

```tsx
// src/tests/blackbox/test-wrapper.tsx
function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>
          {children}
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}
export const renderWithProviders = (ui: React.ReactElement) =>
  render(ui, { wrapper: TestWrapper })
```

The wrapper must include every provider the component tree needs. Missing providers cause cryptic errors — diagnose them by reading the component's import chain for `useContext` calls.

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

#### Frontend variant: Vitest-based test runner

For frontend codebases, the test runner does NOT start a server. Tests run entirely in jsdom/happy-dom.

**If missing:** build it. The frontend test runner must:

1. **Vitest config** — Create or extend `vitest.config.ts` (or add a `test` block to `vite.config.ts`):
   - `environment: 'jsdom'` (or `'happy-dom'`)
   - `setupFiles: ['src/tests/blackbox/setup.ts']`
   - `include: ['src/tests/blackbox/**/*.blackbox.{ts,tsx}']`
   - `globals: true` (for `describe`, `it`, `expect` without imports)
   - `css: false` (skip CSS processing for speed)

2. **Test dependencies** — Ensure dev dependencies include:
   - `vitest`
   - `@testing-library/react` (or `@testing-library/vue`, `@testing-library/svelte`)
   - `@testing-library/user-event`
   - `@testing-library/jest-dom` (for `toBeInTheDocument()` matchers)
   - `msw` (for API mocking and capture)
   - `jsdom` or `happy-dom`

3. **Generate a unique run ID** — Same as backend: timestamp + PID.

4. **Create an artifact directory** — Same as backend: `.context/test-runs/<run-id>/`.

5. **Write a manifest file** — `manifest.json` with:
   - `run_id`
   - `mode` (`jsdom-blackbox` or `happy-dom-blackbox`)
   - `artifact_dir` path
   - `test_environment` (`jsdom` or `happy-dom`)
   - `framework` (react, vue, svelte)

6. **Run the test suite** — Invoke vitest:
   - Domain filtering: `vitest run --reporter=verbose src/tests/blackbox/<domain>.blackbox.tsx`
   - Output to both stdout and `<artifact-dir>/runner.log`
   - Exit code propagation

7. **No process cleanup needed** — jsdom tests don't spawn processes or bind ports. Cleanup is just artifact management.

8. **Support `--list` mode** — List available test domains by scanning `src/tests/blackbox/*.blackbox.{ts,tsx}`.

**Where to put it:** `scripts/run-blackbox-tests.sh` (same location as backend — the script detects frontend vs. backend), or `scripts/run-blackbox-tests-frontend.sh` if both exist in the same repo.

**Verification:** After writing the runner:
1. Run with `--list` and verify it lists domains
2. Run against a trivial passing test and verify the artifact directory is created with manifest.json
3. Verify no orphaned processes after exit (there should be none — jsdom is in-process)

## Inputs

- Required: `$ARGUMENTS` must contain the domain name, module, folder, bounded context, or feature name.
- Treat any extra text in `$ARGUMENTS` as optional hints.
- If the user does not provide route prefixes, source globs, test commands, or dependency details, discover them from the repo.

## Non-negotiable rules

- Test only observable behavior.
- Do not assert internal implementation details such as call counts or "function X was called" unless X is an external boundary.
- **Frontend-specific:** Observable behavior means what the user sees and what the app sends over the network. Never assert on React/Vue/Svelte state, hook return values, component instance methods, or internal store contents. Assert on rendered DOM content, user-visible text, element presence/absence, and captured API requests.
- Prefer real boundary behavior over raw mocks.
- For deterministic request/response third-party boundaries, prefer typed adapters backed by `@with-logic/fast-forward` or an equivalent record/replay harness.
- Use raw mocks only when the boundary is destructive, unsafe, too costly to hit live, requires rare fault injection, or is not meaningfully record/replayable.
- Assert behavior through public entrypoints and externally visible effects:
  - **Backend:** response or handler outputs. **Frontend:** rendered text, element visibility, navigation, toast/alert messages
  - **Backend:** persisted state changes. **Frontend:** UI state changes visible to the user (list updates, form resets, loading indicators)
  - emitted events, jobs, or messages
  - outbound calls at system boundaries (**backend:** captured HTTP calls; **frontend:** MSW-captured API requests)
- Keep tests deterministic, isolated, cleanup-safe, and parallel-safe.
- Use unique test data and avoid shared mutable fixtures.
- Reuse existing test patterns, helpers, and fixtures when possible.
- Prefer minimal supporting test utilities over production code changes.
- Leave unrelated user changes in the worktree untouched.
- Every contract run must emit a run-scoped artifact directory under `.context/test-runs/<run-id>/`.
- Every run must record an agent-readable manifest of ports, URLs, log paths, and mutable resources used by the suite.

## Required discovery

Identify all relevant public entrypoints for the domain.

**Backend entrypoints:**
- HTTP routes
- background jobs or workers
- event consumers or producers
- scheduled tasks
- CLI or admin handlers
- other cross-module public interfaces if there is no transport boundary

**Frontend entrypoints:**
- Page components (route-level components rendered by the router)
- Feature barrel exports (`features/<name>/index.ts`) — the public API of each feature
- User interaction flows that cross multiple components (login flow, checkout flow, CRUD operations)
- Global layout components that gate access (auth wrappers, permission boundaries)
- Modals/dialogs triggered by user actions that make API calls

Build a behavior map before adding tests:
- entrypoint
- input shapes and auth rules (**frontend:** what does the user see when authenticated vs. unauthenticated?)
- happy path outputs (**frontend:** what text/elements appear after successful interaction?)
- failure modes (**frontend:** what error messages appear? does the error boundary catch?)
- state changes (**frontend:** does the UI update to reflect the mutation?)
- async side effects (**frontend:** loading spinners, optimistic updates, toast notifications)
- external boundaries (**frontend:** every `fetch`/API call the component makes, captured via MSW)

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

**Frontend contract coverage** for every page/feature entrypoint:
- **Auth gating:** unauthenticated users see login prompt, not protected content
- **Input validation:** form validation messages appear for invalid input (before any API call is made)
- **Happy path rendering:** correct text, elements, and structure for normal data
- **Empty state:** what renders when the API returns an empty list or no data
- **Error state:** what renders when the API returns an error (MSW handler returns 500)
- **Loading state:** loading indicator appears while API call is in flight
- **Permission gating:** admin-only features hidden or disabled for non-admin users

### 2. Characterization coverage for representative workflows

Capture end-to-end observable outputs for normal and edge workflows. Assert:
- direct output
- state delta
- emitted async side effects
- external boundary interactions

**Frontend characterization coverage** for representative user flows:
- **Direct output:** rendered DOM after each step (e.g., after login → dashboard appears)
- **State delta:** UI reflects mutations (e.g., create agent → agent appears in list without page refresh)
- **Navigation:** router navigates to the correct page after an action
- **Side effects:** toast notifications, modals opening/closing, localStorage writes
- **API sequence:** MSW captures show the correct API calls in the correct order

### 3. Boundary capture coverage

**Every domain that makes API calls MUST capture and assert on the exact outbound requests.** This is not optional — it is how we ensure production parity.

#### Backend boundary capture

The repo provides a fetch capture harness (e.g., `fetchCapture.ts`, `httpx_capture.py`) that wraps the runtime's HTTP client and records all outbound calls when `BLACKBOX_TEST_CAPTURE_OUTBOUND=1`. The blackbox test runner enables this automatically.

For each third-party boundary discovered during the behavior map:
1. **Run the real request** — send a real HTTP request that triggers the outbound call. Use test credentials, seed DB state, or use validation-passing inputs as needed.
2. **Snapshot the capture cursor** before the request: `GET /api/test/captures` → read `nextId - 1` as the cursor.
3. **Read only new captures** after the request: `GET /api/test/captures?after={cursor}`
4. **Filter infrastructure noise** — other domains running concurrently on the same server produce background outbound calls (model refresh, realtime heartbeats, etc.). Filter these out before asserting. Define an `INFRA_URL_PATTERNS` list of known infra URLs (`openrouter.ai`, `supabase.co/realtime`, `api.github.com`, `ip-api.com`, `stripe.com`, `e2b.app`, etc.) and exclude matching captures.
5. **Assert on the captured call** with exact parameter matching:
   - URL pattern (e.g., `https://verify.twilio.com/v2/Services/{SID}/Verifications`)
   - HTTP method
   - Request headers (Content-Type, auth scheme)
   - Request body params (exact key-value pairs)
   - Call ordering (when multiple outbound calls are expected)

**Concurrency isolation — every test must be safe to run alongside other domain tests hitting the same server simultaneously:**
- **Never use clear-then-read for captures.** `DELETE /api/test/captures` followed by `GET /api/test/captures` is racy — another domain's outbound call can land in the window between clear and read. Always use cursor-based reads: snapshot cursor before, read `?after=cursor` after.
- **Check capture availability before running boundary tests.** The capture endpoint returns 401 (not 404) when `BLACKBOX_TEST_CAPTURE_OUTBOUND` is not set, because the catch-all authenticated route intercepts it. Use a `checkCaptureAvailable()` probe that checks for `status === 200` and conditionally skip boundary tests if false.
- **Queue/resource drain loops must check status codes.** Under concurrent load, pop/drain endpoints may return transient 500s. If your drain loop checks `!body.message` to detect "empty", a 500 response (`{error: "..."}`) has `body.message === undefined` (falsy), falsely breaking the loop. Always verify `status === 200` before interpreting the response body.
- **Use unique test data per test.** Generate unique IDs, messages, and resource names (e.g., `${prefix}-${Date.now()}-${pid}-${counter}`) so concurrent tests never collide on shared resources like queues, DB rows, or cache keys.

**Other constraints:**
- Boundary tests MUST run sequentially (not in the parallel pool) because the capture buffer is shared global state.
- If the third-party service rate-limits or returns errors, still assert on the captured call params — the parameters sent are the contract, not the response received.
- If the third-party credentials are not configured (e.g., Twilio not set up), skip the boundary test with a clear log message — do not fail.
- For fire-and-forget async boundaries (e.g., SMS sent after response), add a short delay (~500ms) before reading captures to allow the async call to complete.
- Validation failures that short-circuit before any outbound call should also be tested as boundary tests: assert that 0 outbound calls were made.

**DB state seeding:** If a boundary test requires specific DB state (e.g., a user with a phone number, a subscription), seed it using existing API endpoints or the internal API key. Document what state was seeded and why.

#### Frontend boundary capture (MSW)

The MSW capture harness records every API request the component makes in jsdom. This is the frontend equivalent of fetchCapture — instead of intercepting server-to-third-party calls, it intercepts component-to-backend API calls.

For each API boundary discovered during the behavior map:
1. **Render the component** with default MSW handlers returning realistic responses
2. **Clear captures** before each boundary test: `clearCaptures()`
3. **Trigger the user action** that causes the API call (click a button, submit a form, navigate to a page)
4. **Assert on the captured request** with exact parameter matching:
   - URL path (e.g., `/api/agents`, `/api/auth/send-otp`)
   - HTTP method
   - Request headers (Content-Type, Authorization scheme)
   - Request body (exact JSON keys and values)
   - Call ordering (when a user action triggers multiple sequential API calls)

**Frontend-specific constraints:**
- Capture tests can run in parallel — MSW server is per-test-file in vitest (each file gets its own jsdom environment). However, within a single test file, `capturedRequests` is shared, so use `clearCaptures()` in `beforeEach`.
- For optimistic updates, assert that the UI updated BEFORE the API call resolved (use `server.use()` to delay the response).
- For error handling, override the default handler to return an error: `server.use(http.get('/api/agents', () => HttpResponse.json({ error: 'Server error' }, { status: 500 })))`.
- Validation that prevents the API call from being made should also be tested: assert that 0 captured requests exist after submitting an invalid form.

### 4. Invariant coverage

Include every relevant invariant below. If one is not relevant, explicitly document why it is not applicable.

| Invariant | Backend meaning | Frontend meaning |
|---|---|---|
| **auth boundary** | Protected routes return 401/403 for unauthenticated requests | Protected pages show login/redirect, not content, for unauthenticated users |
| **error surface** | All error responses include `{ error: string }` | Errors are caught by error boundaries and display user-friendly messages, never raw stack traces |
| **idempotency / retry** | Mutating endpoints are idempotent | Submit buttons disable during request; double-click does not create duplicate resources |
| **read-after-write** | Created resource is immediately retrievable | Created item appears in the UI list without page refresh (optimistic or refetch) |
| **concurrency** | Concurrent requests do not corrupt shared state | Rapid re-renders or race conditions do not cause stale state display |
| **state transition** | Entity moves through valid states only | Component state machine: loading → ready → error (never stuck in loading) |
| **ordering / pagination** | List endpoints return correct order and page boundaries | Sorted lists render in correct order; pagination controls navigate correctly |
| **atomicity** | Multi-step mutation is atomic | Multi-step form submission either completes fully or rolls back UI to pre-submit state |
| **referential integrity** | Foreign key constraints hold | Navigating to a deleted resource shows 404/not-found, not a crash |
| **event / job cardinality** | Each trigger produces exactly the expected side effects | Each user action triggers exactly the expected API calls (no duplicates, no missing) |
| **duplication prevention** | Duplicate creation is rejected or deduplicated | UI prevents duplicate submissions (button disable, debounce) |
| **permission / tenant isolation** | User A cannot access User B's resources | Components filter data to current user; no cross-user data leaks in UI |
| **cleanup** | Suite does not leak ports, processes, temp dirs | Suite does not leak subscriptions, timers, or event listeners (unmount cleanup) |
| **observability** | Every failing run points at correct logs and manifest | Same |
| **time / clock** | Timestamp behavior is correct | Relative timestamps ("2 hours ago") render correctly |
| **same-input reproducibility** | Same inputs produce same outputs | Same user actions produce same rendered output |
| **boundary param** | Exact params sent to third-party APIs match expected contract | Exact params sent to backend APIs match expected contract (via MSW capture) |
| **call ordering** | Multiple outbound calls happen in expected order | Multiple API calls from a user flow happen in expected order (via MSW capture) |
| **harness independence** | Background jobs do not affect the suite | N/A for frontend (no background jobs in jsdom) |

**Frontend-only invariants** (not applicable to backend):
- **subscription cleanup**: Components that subscribe to WebSocket, EventSource, setInterval, or ResizeObserver must clean up on unmount. Test: render → unmount → verify no lingering listeners.
- **accessibility gating**: If the domain has aria-live regions, focus management, or keyboard navigation, test that they work (screen reader-visible text, focus moves to correct element after action).

### 5. Flake resistance

- Run the new domain-focused suite repeatedly at least 5 times.
- Fix nondeterminism until stable.
- Ensure the domain suite itself executes its test cases in parallel, with a default intra-domain concurrency of `30` unless the repo proves a lower safe ceiling is required.
- Treat this as a real execution default, not a recommendation: when running a single domain, the suite must actually execute with case concurrency `30` by default unless explicitly justified otherwise.
- Run at least 2 concurrent invocations of the same domain suite and ensure both pass without interference.
- Ensure it can run concurrently with other suites — the test runner runs 6+ domain suites in parallel against the same backend. Tests must not corrupt each other's capture windows, queue state, or DB fixtures.
- Boundary tests that hit real third-party APIs must handle rate-limit and transient error responses gracefully — assert on the captured call params, not on the third-party response status.

**Frontend flake resistance:**
- **jsdom isolation**: Each vitest test file gets its own jsdom environment by default. This provides natural isolation — no port conflicts, no shared state between files.
- **Timer mocking**: If components use `setTimeout`, `setInterval`, `Date.now()`, or `requestAnimationFrame`, use `vi.useFakeTimers()` to make them deterministic. Advance time explicitly with `vi.advanceTimersByTime()`.
- **Animation mocking**: Disable CSS animations/transitions in jsdom. They are a common source of flaky `waitFor` timeouts.
- **Network timing**: MSW responses are synchronous by default (no real network delay). If tests flake on `waitFor` timeouts, the component is likely not triggering the expected render. Debug with `screen.debug()` — do not increase timeouts.
- **Async assertions**: Always use `await waitFor(() => ...)` or `await screen.findByText(...)` for content that appears after an API call. Never use raw `expect()` on async content.
- **No act() warnings**: Fix all `act()` warnings in test output — these indicate untested async updates and are the #1 source of frontend test flakes.
- **Parallel safety**: Vitest runs test files in parallel by default. Since each file gets its own jsdom + MSW server, this is safe. Do NOT use `--sequence` or `--singleThread` unless there is a proven shared-resource issue.

## Naming

- Use `contract` only for narrow wire-level interface checks such as status codes, schemas, and protocol compatibility.
- For the broader safety-net suite described by this command, prefer `blackbox` as the primary name because it encodes the non-negotiable rule: assert observable behavior only, not internals.
- Preferred file template for a domain suite: `<domain>.blackbox.ts` (backend) or `<domain>.blackbox.tsx` (frontend, when tests contain JSX)
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

**For backend external boundaries, trace every `fetch()` call in the domain source to identify:**
- The third-party service URL pattern
- The HTTP method and content type
- The request body structure (JSON fields, URL-encoded params, etc.)
- The auth mechanism (Basic, Bearer, API key header)
- Whether the call is synchronous (awaited before response) or fire-and-forget (async after response)

**For frontend API boundaries, trace every `fetch()`, `axios`, or React Query hook in the domain source to identify:**
- The backend API endpoint URL pattern (e.g., `/api/agents`, `/api/auth/send-otp`)
- The HTTP method and content type
- The request body structure (JSON fields, form data)
- The auth mechanism (JWT in Authorization header, cookie-based, API key)
- Whether the call is triggered by user action (click, submit) or automatic (page load, polling, WebSocket)
- Whether the response triggers UI updates (re-render, navigation, toast)

Produce a resource manifest for the run that includes:
- allocated ports (backend) or test environment (frontend: jsdom/happy-dom)
- spawned services (backend) or provider wrapper configuration (frontend)
- cache or artifact directories
- mutable shared resources and how they are namespaced
- log file locations
- MSW handler count and coverage (frontend)

If focused commands are not obvious:
1. Reuse an existing domain-specific test command if one already exists.
2. Otherwise derive the narrowest reliable test invocation from the repo's existing test runner.
3. For a single-domain run, ensure the default invocation preserves intra-domain case concurrency `30`.
4. Do not confuse top-level runner concurrency with intra-domain concurrency: `domainConcurrency=1` is acceptable only if the domain suite itself still runs its cases in parallel.
5. Also identify a broader relevant suite to run before declaring success.

**Frontend test command derivation:**
1. Reuse an existing vitest config if one exists for blackbox tests.
2. Otherwise derive: `npx vitest run src/tests/blackbox/<domain>.blackbox.tsx --reporter=verbose`
3. The vitest pool handles intra-file parallelism automatically.
4. Broader suite: `npx vitest run src/tests/blackbox/` for all blackbox domains.

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

#### Frontend test implementation pattern

When implementing frontend blackbox tests:

1. **Render the page or feature component** using `renderWithProviders()` (from the test wrapper created in Step 0b)
2. **Set up MSW handlers** for the API calls the component will make on mount or interaction
3. **Interact as a user would** using `@testing-library/user-event`:
   - `await userEvent.click(screen.getByRole('button', { name: 'Submit' }))`
   - `await userEvent.type(screen.getByPlaceholderText('Phone'), '9729777432')`
   - `await userEvent.selectOptions(screen.getByRole('combobox'), 'option-value')`
4. **Assert on visible output** using testing-library queries:
   - `expect(screen.getByText('Welcome back')).toBeInTheDocument()`
   - `expect(screen.queryByText('Loading...')).not.toBeInTheDocument()`
   - `await waitFor(() => expect(screen.getByText('Agent created')).toBeInTheDocument())`
5. **Assert on captured API calls** using the MSW capture:
   - `const req = capturedRequests.find(r => r.url.includes('/api/agents'))`
   - `expect(req.method).toBe('POST')`
   - `expect(req.body).toMatchObject({ name: 'Test Agent' })`

**What NOT to do in frontend blackbox tests:**
- Do NOT import hooks and call them directly (e.g., `renderHook(useAuth)`) — that tests internals
- Do NOT access React/Vue/Svelte state or context values directly — test what the user sees
- Do NOT mock individual functions inside the component — mock at the network boundary (MSW)
- Do NOT use `container.querySelector()` — use testing-library semantic queries (`getByRole`, `getByText`, `getByLabelText`)
- Do NOT test CSS styling or pixel-level layout — test functional behavior only

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

**Frontend-specific perturbations:**
- Change the API endpoint URL in the component's API call (e.g., `/api/agents` → `/api/agent`) — MSW's `onUnhandledRequest: 'error'` should catch it
- Remove the auth token from API call headers — error state should appear
- Change the form validation to accept invalid input — capture test should show wrong params sent
- Remove the error boundary — component should crash instead of showing graceful error
- Remove the submit button disable — idempotency invariant should fail (duplicate API calls captured)

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

**Additional frontend validation gates:**
- MSW is configured with `onUnhandledRequest: 'error'` — no silent unhandled API calls
- Every API boundary has at least one MSW capture test, or is explicitly listed with justification
- No `act()` warnings in test output
- Test wrapper includes all required providers (auth, router, theme, data, etc.)
- Tests use semantic queries (`getByRole`, `getByText`) not implementation queries (`container.querySelector`)

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

**Additional frontend reporting:**
- which test framework and environment was used (vitest + jsdom, vitest + happy-dom)
- MSW handler coverage: how many API endpoints are handled vs. total endpoints the domain calls
- Provider wrapper configuration (which providers are included and why)
- whether `onUnhandledRequest: 'error'` caught any missing handlers during development
- any components that could not be rendered in jsdom (e.g., canvas-based, WebGL) and how they were handled

## Invariant adherence checklist

Before declaring success, emit this checklist verbatim, marking each item PASS, FAIL, or N/A with a one-line justification.

```
INVARIANT ADHERENCE CHECKLIST
=============================

Non-negotiable rules:
[ ] Tests assert only observable behavior, not implementation details
[ ] No assertions on call counts or "function X was called" (unless X is an external boundary)
[ ] Real boundary behavior preferred over raw mocks
[ ] Record/replay harness used for deterministic third-party boundaries (or justified why not)
[ ] Raw mocks used ONLY when boundary is destructive, unsafe, too costly, or not replayable
[ ] Tests are deterministic, isolated, cleanup-safe, and parallel-safe
[ ] Unique test data used — no shared mutable fixtures

Coverage invariants:
[ ] auth boundary — protected routes/pages reject unauthenticated access
[ ] error surface — errors return consistent shape / user-friendly messages
[ ] idempotency / retry — duplicate requests do not corrupt state
[ ] read-after-write — created resource is immediately retrievable/visible
[ ] concurrency — concurrent requests do not corrupt shared state
[ ] state transition — entities move through valid states only
[ ] ordering / pagination — lists return correct order and page boundaries
[ ] atomicity — multi-step mutations are atomic
[ ] referential integrity — FK constraints hold / deleted resources show 404
[ ] event / job cardinality — each trigger produces exactly expected side effects
[ ] duplication prevention — duplicate creation is rejected or deduplicated
[ ] permission / tenant isolation — user A cannot access user B's resources
[ ] cleanup — suite does not leak ports, processes, temp dirs, subscriptions
[ ] observability — every failing run points at correct logs and manifest
[ ] time / clock — timestamp behavior is correct
[ ] same-input reproducibility — same inputs produce same outputs
[ ] boundary param — exact params sent to third-party/backend APIs match expected contract
[ ] call ordering — multiple outbound calls happen in expected order
[ ] harness independence — background jobs do not affect the suite

Validation gates:
[ ] New domain suite passes
[ ] Existing relevant tests still pass
[ ] Intra-domain case concurrency = 30 (or justified)
[ ] Concurrent invocations pass without interference
[ ] Every public entrypoint covered or listed as residual risk
[ ] Every skipped invariant justified
[ ] Every third-party boundary has capture test (or justified)
[ ] Negative-control checks proved tests fail on deliberate breakage
[ ] Final restored code is green
```

Mark each item and include the checklist in the final response. Any FAIL item blocks the `Domain safety net ready for autonomous refactoring` declaration.

---

Only say:
`Domain safety net ready for autonomous refactoring`

if every validation gate passed and no checklist item is FAIL.

Otherwise say:
`Domain safety net not ready for autonomous refactoring`

and list the blockers.
