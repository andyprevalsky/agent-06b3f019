# Testing

Single source of truth for running tests. All commands run from the repo root.

## Quick Start

```bash
bash scripts/test.sh --port=3001                   # everything: offline + smoke + semantic (requires running services)
bash scripts/test.sh --no-smoke                    # offline-only (skips smoke + Playwright semantic)
bash scripts/test.sh --no-smoke agents             # single repo (offline)
bash scripts/test.sh --no-smoke agents web-search  # single domain (offline)
bash scripts/test.sh --no-smoke back-end auth      # backend blackbox: auth domain
bash scripts/test.sh --list                        # list available repos/domains
```

## Test Suites

| Suite | Command | Server Required | Filtering |
|-------|---------|-----------------|-----------|
| Offline-only | `bash scripts/test.sh --no-smoke` | No | repo, domain |
| All (offline + smoke + semantic) | `bash scripts/test.sh --port=N` | Yes | — |
| Agents blackbox | `cd agents && python scripts/run_blackbox_tests.py [domain]` | No | domain |
| Backend structural | `cd back-end && npx tsx src/tests/structural/layer-deps.test.ts` | No | — |
| Backend blackbox | `cd back-end && bash scripts/run-blackbox-tests.sh [domain]` | No (self-manages) | domain |
| Frontend blackbox | `cd front-end && bash scripts/run-blackbox-tests.sh [domain]` | No | domain |
| Smoke benchmarks | `cd agents && python benchmarks/run_benchmark.py --suite smoke --port=N` | Yes | — |
| Backend ESLint | `cd back-end && npm run lint` | No | — |
| Frontend ESLint | `cd front-end && npm run lint` | No | — |

## Suite Details

### Agents Blackbox (`agents/tests/blackbox/`)

Python tests that exercise agent tools (web_search, send_sms, etc.) with mocked HTTP boundaries via `httpx_capture`. No backend or external services needed.

```bash
cd agents && python scripts/run_blackbox_tests.py              # all domains
cd agents && python scripts/run_blackbox_tests.py web-search    # single domain
cd agents && python scripts/run_blackbox_tests.py --list        # list domains
```

### Backend Structural (`back-end/src/tests/structural/`)

Architecture invariant tests — import direction, cross-domain isolation, provider boundaries, Prisma/Express encapsulation. Fast, no server needed.

```bash
cd back-end && npm run test:structural
```

### Backend Blackbox (`back-end/src/tests/blackbox/`)

TypeScript tests that exercise backend API endpoints. The runner script auto-starts an isolated backend on a dedicated port — no manual server setup needed.

```bash
cd back-end && npm run test:blackbox                # all domains
cd back-end && bash scripts/run-blackbox-tests.sh auth  # single domain
```

### Frontend Blackbox (`front-end/src/tests/blackbox/`)

Vitest-based tests that exercise frontend components and logic in jsdom.

```bash
cd front-end && bash scripts/run-blackbox-tests.sh              # all domains
cd front-end && bash scripts/run-blackbox-tests.sh terminal      # single domain
```

### Smoke Benchmarks (`agents/benchmarks/`)

End-to-end tests that spawn real agents against a running backend. Requires all services (back-end + agents + research) to be running.

```bash
cd agents && python benchmarks/run_benchmark.py --suite smoke --port 3001 --ci --parallel
```

The `--port` flag is required for local runs — there is no implicit port default. Use `--prod` to run against production instead.

## Adding New Tests

- **Backend API endpoint:** Add `back-end/src/tests/blackbox/<domain>.blackbox.ts`
- **Agent tool:** Add `agents/tests/blackbox/<tool-name>/test_<tool-name>.py`
- **Frontend component:** Add `front-end/src/tests/blackbox/<domain>.blackbox.tsx`
