---
description: "Set up code coverage enforcement for a service. Installs tooling, configures thresholds, updates deploy/push skills and the service's own CLAUDE.md."
argument-hint: "<service-dir> (e.g., back-end, front-end, agents)"
---

# Enforce Code Coverage

Set up code coverage measurement and enforcement for a service directory. Installs the appropriate coverage library, configures thresholds, adds npm/pip scripts, and wires coverage checks into the deploy and push skills.

If `$ARGUMENTS` is empty, ask the user which service directory to target and stop.

**This is a loop. Do NOT stop until coverage tooling is installed, thresholds are configured, the coverage report runs green, and deploy/push and the service's CLAUDE.md are updated.**

---

## Step 0: Identify the service and its test stack

Read the service directory to determine:

1. **Language**: TypeScript (Node), Python, or other
2. **Test runner**: What command runs the tests today? Check `package.json` scripts, `pyproject.toml`, the service's own `$ARGUMENTS/CLAUDE.md`, or `docs/testing.md`.
3. **Existing coverage tooling**: Is any coverage library already installed? Check `package.json` devDependencies, `requirements.txt`, `pyproject.toml`.
4. **Test command baseline**: Run the existing test command once to confirm tests pass BEFORE adding coverage. If tests fail, stop and tell the user — coverage enforcement on a broken test suite is pointless.

```bash
# TypeScript — check for existing coverage deps
cd $ARGUMENTS && cat package.json | grep -i "coverage\|nyc\|istanbul\|c8\|vitest"

# Python — check for existing coverage deps
cd $ARGUMENTS && grep -i "coverage\|pytest-cov" requirements*.txt pyproject.toml 2>/dev/null
```

---

## Step 1: Install coverage tooling

Install the appropriate coverage library based on the language and test runner. **Do not replace the existing test runner** — add coverage on top of it.

### TypeScript / Node

**If tests use Vitest** (e.g., front-end):
- `@vitest/coverage-v8` is the coverage provider. Install if not already present:
  ```bash
  cd $ARGUMENTS && npm install --save-dev @vitest/coverage-v8
  ```
- Add coverage config to `vitest.config.ts` (or `vite.config.ts` if tests are configured there):
  ```typescript
  export default defineConfig({
    test: {
      coverage: {
        provider: 'v8',
        reporter: ['text', 'text-summary', 'json-summary'],
        reportsDirectory: './coverage',
        thresholds: {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },
      },
    },
  });
  ```

**If tests use custom tsx runners** (e.g., back-end with `tsx src/tests/...`):
- Use `c8` — it wraps any Node process and collects V8 coverage without requiring a specific test framework:
  ```bash
  cd $ARGUMENTS && npm install --save-dev c8
  ```
- Add a `.c8rc.json` config in the service directory:
  ```json
  {
    "all": true,
    "src": ["src/"],
    "exclude": ["src/tests/**", "node_modules/**", "**/*.d.ts", "**/*.test.ts"],
    "reporter": ["text", "text-summary", "json-summary"],
    "reports-dir": "./coverage",
    "check-coverage": true,
    "lines": 80,
    "functions": 80,
    "branches": 80,
    "statements": 80
  }
  ```

### Python

- Use `coverage` (stdlib-compatible, works with any runner):
  ```bash
  cd $ARGUMENTS && pip install coverage && echo "coverage" >> requirements.txt
  ```
- If `pytest` is the test runner, prefer `pytest-cov`:
  ```bash
  cd $ARGUMENTS && pip install pytest-cov && echo "pytest-cov" >> requirements.txt
  ```
- Add coverage config to `pyproject.toml` (create `[tool.coverage]` section if needed):
  ```toml
  [tool.coverage.run]
  source = ["src/", "."]
  omit = ["tests/*", "benchmarks/*", "*/__pycache__/*"]

  [tool.coverage.report]
  fail_under = 80
  show_missing = true
  skip_empty = true
  exclude_lines = [
    "pragma: no cover",
    "if __name__ == .__main__.",
    "if TYPE_CHECKING:",
  ]
  ```

---

## Step 2: Add coverage scripts

Add convenience scripts so coverage can be run with a single command.

### TypeScript (Vitest)

Add to `package.json` scripts:
```json
{
  "test:coverage": "vitest run --coverage",
  "test:coverage:report": "vitest run --coverage --reporter=verbose"
}
```

### TypeScript (c8 + custom runners)

Add to `package.json` scripts. Wrap the **existing** test command with `c8`:
```json
{
  "test:coverage": "c8 npm run test:api",
  "test:coverage:report": "c8 report --reporter=text"
}
```

If the service has multiple test commands (e.g., `test:api`, `test:blackbox`, `test:structural`), wrap the primary suite that exercises business logic — not structural/architectural tests.

### Python (coverage)

No `package.json` to edit. The coverage command is:
```bash
# With coverage.py directly:
coverage run -m pytest tests/ && coverage report

# With pytest-cov:
pytest --cov=. --cov-report=term --cov-fail-under=80 tests/
```

---

## Step 2a: Identify the fetch capture / replay layer

Check if the service already has a fetch capture provider backed by `@with-logic/fast-forward`. This is the mechanism that makes third-party integration code testable via blackbox tests:

```bash
# Check for fast-forward dependency
cd $ARGUMENTS && grep -r "fast-forward" package.json 2>/dev/null

# Check for a fetch capture provider
grep -rl "installFetchCapture\|fetchCapture\|fast-forward" src/ 2>/dev/null
```

### How it works

`@with-logic/fast-forward` wraps any object in a cache-aware Proxy. In this codebase, the fetch capture provider (`src/providers/fetchCapture.ts`) wraps `globalThis.fetch` so that:

1. **First test run**: Real outbound HTTP calls are made to third-party APIs (Stripe, Twilio, Supabase, etc.), and responses are cached to `.context/fast-forward-cache/` as individual JSON files (SHA-256 hashed by URL + method + body).
2. **Subsequent runs**: Cached responses are replayed instantly — no real API calls, no cost, deterministic.
3. **Cache has no eviction policy** — entries persist forever. This is intentional: stale cache entries catch API contract changes. To re-record, either delete specific cache files or use `FASTFORWARD_MODE=UPDATE_ONLY`.

**Activation**: Set `BLACKBOX_TEST_CAPTURE_OUTBOUND=1` before server boot. The test server mounts capture endpoints at `/api/test/captures`.

**Test endpoints available when capture is active:**
- `GET /api/test/captures` — list captured outbound calls (supports `?after=N` cursor)
- `DELETE /api/test/captures` — clear in-memory capture log (not the disk cache)
- `DELETE /api/test/captures/cache` — clear the fast-forward disk cache (forces re-record)

### Why this matters for coverage

Without fast-forward, code that calls third-party APIs (OAuth callbacks, Stripe webhooks, Twilio OTP, etc.) appears "untestable" via blackbox tests. With it, those code paths are fully testable — the first run hits real APIs and caches responses, then all subsequent runs replay from cache. **Do NOT exclude files from coverage just because they call external services** — write tests that exercise those paths and let fast-forward handle the caching.

Only exclude files that are genuinely unreachable via HTTP (e.g., code that requires a live WebSocket/CDP connection, Temporal workflow internals that need a running Temporal server).

### Writing tests that hit third-party APIs

When writing blackbox tests for code paths that make outbound calls:

1. **Ensure `BLACKBOX_TEST_CAPTURE_OUTBOUND=1`** is set in the test server's environment (check the test runner script).
2. **Use real credentials** — the first run needs them. They're typically in the service's `.env` file. The capture layer redacts sensitive headers in the log but passes them through to the real API.
3. **Clean up resources** after each test — if the test creates real resources on third-party APIs (Stripe customers, Twilio verifications, etc.), delete them in cleanup to avoid state pollution on re-record.
4. **Commit the cache directory** (`.context/fast-forward-cache/`) so CI replays from cache without needing credentials.
5. **To re-record**: Delete the relevant cache files or run with `FASTFORWARD_MODE=UPDATE_ONLY`. This is needed when:
   - A third-party API changes its response schema
   - You add a new test that hits a new endpoint
   - The request shape changes (URL, method, or body — headers are excluded from the cache key)

---

## Step 3: Run coverage and assess baseline

Run the coverage command to get a baseline measurement:

```bash
cd $ARGUMENTS && npm run test:coverage  # or Python equivalent
```

Read the output. Key numbers to look at:
- **Overall line coverage %**
- **Overall branch coverage %**
- **Files with 0% coverage** (untested modules)
- **Files below threshold**

### Set realistic thresholds

If baseline coverage is **below 80%**, do NOT set the threshold to 80% and call it done — the check will fail. Instead:

1. **Round the current baseline DOWN to the nearest 5%** and use that as the initial threshold (e.g., baseline 63% → threshold 60%).
2. Leave a comment in the config noting the target: `// Target: 80%. Current baseline: 63%. Ratchet up as tests are added.`
3. The threshold acts as a **ratchet** — it prevents coverage from dropping, and should be bumped upward as new tests are written.

Update the threshold values in the coverage config file from Step 1.

### Coverage exclusions — be conservative

Only exclude files that are **structurally unreachable** via the test harness:
- Code requiring a live WebSocket/CDP browser connection
- Temporal workflow sandbox internals (need a running Temporal server)
- Files that are pure type definitions (0 executable lines)

**Do NOT exclude** files just because they call third-party APIs. If the service has a fast-forward fetch capture layer (Step 2a), those paths are testable — write tests that exercise them and let the cache handle replay. The bar for exclusion is "physically impossible to reach via an HTTP request to the test server," not "inconvenient to test."

---

## Step 4: Verify coverage check passes

Run the coverage command again with the adjusted threshold:

```bash
cd $ARGUMENTS && npm run test:coverage  # or Python equivalent
```

**Must exit 0.** If it fails:
- Check if the threshold is set correctly
- Check if test files are excluded from coverage measurement (they should be)
- Check if the `src` / source directory is configured correctly
- Fix and re-run until it passes

---

## Step 5: Add coverage to .gitignore

Coverage reports generate artifacts that should not be committed:

```bash
# Check if coverage/ is already ignored
cd $ARGUMENTS && grep -q "coverage" .gitignore 2>/dev/null || echo -e "\n# Coverage reports\ncoverage/" >> .gitignore
```

Also check the repo-root `.gitignore`.

---

## Step 6: Update the deploy skill

Read `.claude/commands/deploy.md`. Add a coverage check step to **Phase 1: Test Loop**, after the existing test steps but before spinning up local services (Step 5).

The new step should:
- Only run if the changed files include the target service directory
- Run the coverage command
- Fail the test loop if coverage is below threshold

Example addition (adapt step numbering to fit):

````markdown
## Step N: Code coverage check (skip if no $ARGUMENTS/ changes)

```bash
cd $ARGUMENTS && npm run test:coverage
```

Coverage must meet the configured thresholds. If it fails, add tests to cover the gap before proceeding.
````

**Important**: Do NOT renumber existing steps — insert the new step with a letter suffix (e.g., Step 4a) or as the next available number if it goes at the end of Phase 1.

---

## Step 7: Update the push skill

Read `.claude/commands/push.md`. Add a coverage check to **Step 1** (local tests), following the same pattern as deploy.

Example addition:

````markdown
### 1f. Code coverage (skip if no $ARGUMENTS/ changes)

```bash
cd $ARGUMENTS && npm run test:coverage
```
````

---

## Step 8: Update the service's CLAUDE.md

Document coverage where the service's other test commands live: `$ARGUMENTS/CLAUDE.md` (its `AGENTS.md` is a symlink to it). For a service without its own CLAUDE.md, use that service's entry in `docs/testing.md` instead. Add, in the file's existing one-line-per-rule bullet style:

1. **How to run coverage** for the service: `cd $ARGUMENTS && npm run test:coverage` (check thresholds) and `npm run test:coverage:report` (detailed report)
2. **Current threshold**: e.g., "80% line/branch/function/statement coverage required (`<config file>`)"
3. **How the ratchet works**: "Thresholds only go up, never down. Bump them after adding tests."

Keep the addition concise — 3 bullets at most. Never add a **Tests** or coverage block, commands or threshold numbers to the root `CLAUDE.md`: its Testing section keeps a single bullet naming the threshold config files that only ratchet up. Only add the new service's config path to that existing bullet, keeping it one line.

---

## Step 9: Final verification

Run the full test suite for the service to make sure coverage instrumentation doesn't break anything:

```bash
cd $ARGUMENTS && npm run test:all  # or whatever runs all tests
```

Then run the coverage check one final time:

```bash
cd $ARGUMENTS && npm run test:coverage
```

Both must pass.

---

## Step 10: Report

Output:
- **Service**: which directory was set up
- **Coverage library**: what was installed
- **Baseline coverage**: the numbers before any threshold was set
- **Configured threshold**: the threshold set in the config
- **Scripts added**: the npm/pip commands available
- **Files modified**: list of files changed (config, package.json, `$ARGUMENTS/CLAUDE.md` or `docs/testing.md`, the root CLAUDE.md coverage bullet if extended, deploy.md, push.md, .gitignore)
- **Coverage report**: final coverage numbers

Only say **`Code coverage enforcement complete`** if ALL of:
- [ ] Coverage library installed and configured
- [ ] Coverage scripts added to package.json (or equivalent)
- [ ] Coverage check passes with configured thresholds
- [ ] coverage/ directory is gitignored
- [ ] deploy.md updated with coverage step
- [ ] push.md updated with coverage step
- [ ] Service CLAUDE.md (or `docs/testing.md`) updated with coverage instructions; root CLAUDE.md only gained the config path in its existing coverage bullet
- [ ] Full test suite still passes
