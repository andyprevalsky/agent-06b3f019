"""Deterministic environment defaults for every agents test entrypoint.

Agents tests mock all outbound HTTP, so credentials only ever need to be
*present* — never real. Historically these defaults lived only inside
`scripts/run_blackbox_tests.py`, so the pytest suites (and any domain that
happened to run in isolation) depended on `agents/.env` being symlinked by
Conductor's setup script. In a plain `git worktree`, which that setup never runs
against, the suites failed with opaque errors (`KeyError: 'TEMPORAL_API_KEY'`,
`Missing SUPABASE_SERVICE_ROLE_KEY environment variable`, or a boundary
assertion that captured 0 requests because a provider was silently skipped for
lack of a key).

One source of truth, applied with `setdefault` so a real environment always
wins.
"""

from __future__ import annotations

import os

TEST_ENV_DEFAULTS: dict[str, str] = {
    "TEMPORAL_API_KEY": "blackbox-temporal-key",
    "TEMPORAL_NAMESPACE": "blackbox.namespace",
    "TEMPORAL_ADDRESS": "localhost:7233",
    "TEMPORAL_TASK_QUEUE": "blackbox-agent-tasks",
    "OPENROUTER_API_KEY": "blackbox-openrouter-key",
    "OPENAI_API_KEY": "blackbox-openai-key",
    "PERPLEXITY_API_KEY": "blackbox-perplexity-key",
    "GEMINI_API_KEY": "blackbox-gemini-key",
    "BROWSERBASE_API_KEY": "blackbox-browserbase-key",
    "BROWSERBASE_PROJECT_ID": "blackbox-browserbase-project",
    "BACKEND_API_KEY": "blackbox-backend-key",
    "SUPABASE_SERVICE_ROLE_KEY": "blackbox-supabase-service-role-key",
    # web-search's boundary test asserts the Parallel AI request. Without a key
    # the service skips that provider entirely, so the domain passed only when
    # some earlier domain had already populated the env — it failed in every
    # isolated run, which is exactly how the coverage shards execute it.
    "PARALLEL_API_KEY": "blackbox-parallel-key",
}


def apply_test_env_defaults() -> None:
    """Populate missing test credentials without overriding a real environment."""
    for name, value in TEST_ENV_DEFAULTS.items():
        os.environ.setdefault(name, value)
