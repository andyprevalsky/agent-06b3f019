"""Deterministic test sharding for /deploy structural gates.

`run-deploy-structural-gates.py` splits a long suite into N gates and exports
``DEPLOY_GATE_SHARD=i/N`` (1-based) to each. Every shard runs the same command
and selection; shard i keeps every N-th collected test starting at index i-1,
so the union over all shards is exactly the unsharded selection and no test
runs twice. Without the variable nothing is filtered.

Loaded as a pytest plugin (``-p deploy_gate_shard``) and imported by unittest
wrappers through ``select_unittest``.
"""

from __future__ import annotations

import os
import unittest
from typing import Iterator, Sequence, TypeVar

ENV = "DEPLOY_GATE_SHARD"
T = TypeVar("T")


def shard_spec() -> tuple[int, int] | None:
    raw = os.environ.get(ENV, "").strip()
    if not raw:
        return None
    index_text, _, count_text = raw.partition("/")
    index, count = int(index_text), int(count_text)
    if count < 1 or not 1 <= index <= count:
        raise ValueError(f"{ENV}={raw!r} must be i/N with 1 <= i <= N")
    return index, count


def select(items: Sequence[T]) -> tuple[list[T], list[T]]:
    """Return (kept, dropped) for this process's shard."""
    spec = shard_spec()
    if spec is None:
        return list(items), []
    index, count = spec
    kept = [item for position, item in enumerate(items) if position % count == index - 1]
    dropped = [item for position, item in enumerate(items) if position % count != index - 1]
    return kept, dropped


def pytest_collection_modifyitems(config, items) -> None:  # pragma: no cover - pytest hook
    if shard_spec() is None:
        return
    kept, dropped = select(items)
    if dropped:
        config.hook.pytest_deselected(items=dropped)
    items[:] = kept


def _flatten(suite: unittest.TestSuite) -> Iterator[unittest.TestCase]:
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            yield from _flatten(test)
        else:
            yield test


def run_unittest_module(module_name: str = "__main__") -> None:
    """unittest.main() replacement that honours DEPLOY_GATE_SHARD."""
    if shard_spec() is None:
        unittest.main(module=module_name)
        return
    loader = unittest.TestLoader()
    import sys

    tests = list(_flatten(loader.loadTestsFromModule(sys.modules[module_name])))
    kept, _ = select(tests)
    result = unittest.TextTestRunner(verbosity=1).run(unittest.TestSuite(kept))
    raise SystemExit(0 if result.wasSuccessful() and kept else 1)
