# agents

Python Temporal worker rules (Fly.io). The root `CLAUDE.md` still applies; numbers in parentheses are stable rule IDs.

## Temporal

- Workflows are deterministic: no `random`, `uuid.uuid4()` or wall-clock reads in workflow code; use `workflow.now()` / `workflow.uuid4()`, or `helpers/workflow_safe.py` (`safe_now`, `safe_uuid4`) for code that runs in both workflow and activity scope. `tests/blackbox/workflow_determinism.blackbox.py` guards this.
- Activities are at-least-once: check for an existing result or use an idempotency key before every side effect (rule 20).
- Activities may run on any worker machine: never rely on module-level shared state; fetch from the backend API when a value is not local (Claim Check).
- Keep activity args small and serializable (IDs, names, flags) and resolve rich objects inside the activity; workflow history accumulates toward Temporal's 2 MB payload limit.
- Keep imports in workflow-sandboxed modules such as `domains/spawn_agent/handler.py` (re-exported by `tools/spawn_agent.py`) at module level; a lazy import inside a method raises sandbox `threading.Lock` errors.
- Any activity wrapper that calls an LLM allows at least 60 seconds.

## Tools

- New tools follow the `ToolManager` pattern in `tools/base.py`; study an existing tool first.
- In tools and activities, catch errors, format them and yield an error event instead of raising.

## Running and testing

- Activate the venv before tests or helpers: `cd agents && source venv/bin/activate`. An absolute `venv/bin/python` alone leaves child `python3` on the wrong interpreter.
- Blackbox suites: `python scripts/run_blackbox_tests.py [domain...]`; coverage: `bash scripts/run-coverage.sh` (80% line+branch in `pyproject.toml`, ratchets up only).
- Workers don't hot-reload, and old agents hit nondeterminism after code changes: restart the worker and create a fresh agent.

## Logging

Always log these, with a `[Component]` prefix, the relevant IDs, and payloads truncated to 200 characters:

1. HTTP requests: method, path, body, response status, duration.
2. External calls (Temporal, LLM, third-party APIs): request and response.
3. Workflow events: phase transitions, signals, completion or failure.
4. Tool execution: tool name, input summary, output summary, duration.
5. DB mutations: table, operation, record ID.
6. Errors: message, stack and context (`agentId`, `userId`).
