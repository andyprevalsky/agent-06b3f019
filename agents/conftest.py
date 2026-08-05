"""Pytest bootstrap for the agents package.

`config.load_config()` reads credentials at import time, so the deterministic
test defaults must be in the environment before any test module is collected.
Applying them here keeps `pytest tests/...` runnable in a checkout that has no
`agents/.env` — the state every plain `git worktree` starts in.
"""

import sys
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parent
if str(AGENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENTS_ROOT))

from tests.env_defaults import apply_test_env_defaults  # noqa: E402

apply_test_env_defaults()
