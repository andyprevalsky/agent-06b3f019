"""Load tests/blackbox/_test_utils for one unit test, then undo its process-wide setup.

`_test_utils` (and run_blackbox_tests.run_single_domain, which imports it) patches
httpx.AsyncClient (capture buffers whole response streams), exports capture/credential
env vars, extends sys.path and stubs Temporal's workflow clock at import. `pytest
tests/unit` shares one interpreter, so leaving that installed changed later unit tests
(the Foundry post-content stream case saw its stream error before any content);
tests/unit/conftest.py fails any test that leaks it.
"""

import importlib
import os
import sys
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

AGENTS = Path(__file__).resolve().parents[2]


@contextmanager
def blackbox_harness():
    """Yield the freshly imported `_test_utils` module; restore everything on exit."""
    from helpers import httpx_capture

    env, path = dict(os.environ), list(sys.path)
    started = list(mock._patch._active_patches)
    # The blackbox helpers live beside the domains, which import them as `_test_utils`.
    sys.path.insert(0, str(AGENTS / "tests" / "blackbox"))
    try:
        yield importlib.import_module("_test_utils")
    finally:
        for patcher in [p for p in mock._patch._active_patches if p not in started]:
            patcher.stop()
        httpx_capture.uninstall_capture()
        httpx_capture.clear_mock_handler()
        sys.modules.pop("_test_utils", None)
        sys.path[:] = path
        os.environ.clear()
        os.environ.update(env)
