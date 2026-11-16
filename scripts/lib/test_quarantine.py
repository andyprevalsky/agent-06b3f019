"""In-definition test quarantine: @quarantine(since=, repair=, error=, evidence=).

The marker lives on the test itself (no shared list to conflict on). A quarantined test still
runs; its failure never fails the run. Each run reports one DEPLOY_GATE_PROGRESS row
(QUARANTINED_FAIL or QUARANTINED_PASS, carrying the marker metadata) and prints one line that
log readers find without the progress file:

    TEST_QUARANTINE status=<STATUS> unit=<id> since=<YYYY-MM-DD> repair=<boxes.dev thread URL>

    test ──@quarantine──> run body ─ok──> QUARANTINED_PASS ┐
                                  └raise─> QUARANTINED_FAIL ┴─> stdout line
                                                             └─> row: $DEPLOY_GATE_QUARANTINE_PROGRESS
                                                                      (a runner forwards it) or
                                                                      $DEPLOY_GATE_PROGRESS

Runners that strip DEPLOY_GATE_PROGRESS from their children (so fixture runners cannot report
fixture failures as the gate's) give each child DEPLOY_GATE_QUARANTINE_PROGRESS instead and
forward() only its valid QUARANTINED_* rows afterwards. DEPLOY_GATE_QUARANTINE_UNIT_PREFIX names
the runner's unit (an agents blackbox domain, a structural suite) so ids read <prefix>::<case>.

Smoke benchmark tasks carry the same four keys as a `quarantine` object on their
agents/benchmarks/tasks.json entry (validate_mapping(); long_horizon.validate_catalog() and the
deploy smoke adapter scripts/deploy_test_cloud.py refuse an invalid one). Their unit id is the task name.

Unit id: the pytest node id under pytest, TestCase.id() under unittest, else the function's
qualified name. Metadata is validated when the decorator is applied, so a marker without a
valid date, boxes.dev repair thread, verbatim error line and evidence reference fails at import.
Stdlib only; importable from scripts/tests and agents tests with scripts/lib on sys.path.
"""
from __future__ import annotations

import asyncio
import contextlib
import datetime
import functools
import importlib.util
import inspect
import os
import re
import sys
import traceback
import unittest
from pathlib import Path
from typing import Any, Callable

QUARANTINE_PROGRESS_ENV = 'DEPLOY_GATE_QUARANTINE_PROGRESS'
UNIT_PREFIX_ENV = 'DEPLOY_GATE_QUARANTINE_UNIT_PREFIX'
REPAIR_PATTERN = re.compile(r'https://boxes\.dev/thread/[A-Za-z0-9_-]+'
                            r'|pending-handoff:[0-9a-f]{32}')
# Repairs are dispatched only after merge (.claude/shared/deploy-failure-policy.md): a marker added
# before merge names its FLAKY occurrence as `pending-handoff:<occurrence id>`, and the post-merge
# records PR replaces it with the dispatched thread URL (deploy_test_quarantine.py link-repair).
PENDING_HANDOFF = re.compile(r'pending-handoff:([0-9a-f]{32})')
DATE_PATTERN = re.compile(r'\d{4}-\d{2}-\d{2}')
# Control flow, not test failures: skips, interrupts, exits and cancellation pass through.
_PASSTHROUGH = (KeyboardInterrupt, SystemExit, GeneratorExit, asyncio.CancelledError, unittest.SkipTest)
_PYTEST_PASSTHROUGH = ('Skipped', 'XFailed', 'Exit')


def _load_progress():
    name = 'deploy_gate_progress'
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).resolve().parents[1] / f'{name}.py'
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f'cannot load {path}')
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


progress = _load_progress()


class QuarantineMetadataError(ValueError):
    """A @quarantine marker is missing or has invalid metadata."""


def validate(*, since: object, repair: object, error: object, evidence: object) -> dict[str, str]:
    problems = []
    if not isinstance(since, str) or not DATE_PATTERN.fullmatch(since):
        problems.append('since must be a YYYY-MM-DD date')
    else:
        try:
            datetime.date.fromisoformat(since)
        except ValueError:
            problems.append(f'since is not a calendar date: {since!r}')
    if not isinstance(repair, str) or not REPAIR_PATTERN.fullmatch(repair):
        problems.append('repair must be the boxes.dev thread URL of the repair /goal '
                        '(https://boxes.dev/thread/<id>) or, before merge, pending-handoff:<occurrence id>')
    for key, value in (('error', error), ('evidence', evidence)):
        if not isinstance(value, str) or not value.strip() or '\n' in value or '\r' in value:
            problems.append(f'{key} must be one non-empty line')
    if problems:
        raise QuarantineMetadataError('@quarantine refused: ' + '; '.join(problems))
    return {'since': since, 'repair': repair, 'error': error.strip(), 'evidence': evidence.strip()}


def validate_mapping(value: object, *, owner: str) -> dict[str, str]:
    """A benchmark task's `quarantine` object in agents/benchmarks/tasks.json: exactly the four
    decorator keys, validated by the same rules. `owner` (the task name) prefixes the refusal."""
    keys = ('since', 'repair', 'error', 'evidence')
    if not isinstance(value, dict) or set(value) != set(keys):
        raise QuarantineMetadataError(f'{owner}: quarantine refused: must be an object with exactly the keys {keys}')
    try:
        return validate(**value)
    except QuarantineMetadataError as error:
        raise QuarantineMetadataError(f'{owner}: {error}') from None


def _passthrough(exc: BaseException) -> bool:
    if isinstance(exc, _PASSTHROUGH):
        return True
    # pytest rewrites its outcome classes' __module__ to "builtins"; compare the classes themselves.
    outcomes = sys.modules.get('_pytest.outcomes')
    kinds = tuple(getattr(outcomes, name) for name in _PYTEST_PASSTHROUGH if hasattr(outcomes, name))
    return bool(kinds) and isinstance(exc, kinds)


def unit_id(fn: Callable, args: tuple) -> str:
    current = os.environ.get('PYTEST_CURRENT_TEST', '')
    if current and '_pytest' in sys.modules:
        base = current.rsplit(' ', 1)[0]  # "<nodeid> (call)"
    elif args and isinstance(args[0], unittest.TestCase):
        base = args[0].id().removeprefix('__main__.')
    else:
        base = fn.__qualname__
    prefix = os.environ.get(UNIT_PREFIX_ENV, '')
    return f'{prefix}::{base}' if prefix else base


def record(meta: dict[str, str], unit: str, status: str, detail: str = '') -> dict:
    """Print the TEST_QUARANTINE line and append the row; never raises on a broken progress file."""
    value = progress.row(unit, status, detail=detail, quarantine=meta)
    print(progress.stdout_line(value), flush=True)
    target = os.environ.get(QUARANTINE_PROGRESS_ENV) or os.environ.get(progress.ENV)
    if target:
        progress.report(unit, status, detail=detail, quarantine=meta, path=target)
    return value


def _failed(meta: dict[str, str], unit: str, exc: BaseException) -> None:
    detail = ''.join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    print(f'quarantined test failed (non-blocking): {unit}\n{detail}', file=sys.stderr, flush=True)
    record(meta, unit, 'QUARANTINED_FAIL', detail)


@contextlib.contextmanager
def _subtests(args: tuple):
    """Collect failures of unittest subTest() blocks inside a quarantined method.

    unittest.subTest() records a failing block on the result and does not re-raise, so the
    wrapper would otherwise report QUARANTINED_PASS while that subtest fails the run. Each
    block still runs under the original subTest() (skips stay subtest skips); a failure is
    kept here instead, and the next block still runs, as unittest does.
    """
    case = args[0] if args and isinstance(args[0], unittest.TestCase) else None
    failures: list[BaseException] = []
    if case is None:
        yield failures
        return
    original = case.subTest

    @contextlib.contextmanager
    def subtest(*sub_args: Any, **params: Any):
        with original(*sub_args, **params):
            try:
                yield
            except BaseException as exc:
                if _passthrough(exc):
                    raise
                exc.add_note(f'in subTest {sub_args or ""}{params or ""}'.strip())
                failures.append(exc)

    case.subTest = subtest
    try:
        yield failures
    finally:
        del case.subTest


def _combined(failures: list[BaseException]) -> BaseException:
    return failures[0] if len(failures) == 1 else BaseExceptionGroup('quarantined subtests failed', failures)


def quarantine(*, since: str, repair: str, error: str, evidence: str) -> Callable[[Callable], Callable]:
    meta = validate(since=since, repair=repair, error=error, evidence=evidence)

    def decorate(fn: Callable) -> Callable:
        if inspect.isclass(fn) or not callable(fn):
            raise QuarantineMetadataError('@quarantine marks a test function or method, not a class')

        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def run_async(*args: Any, **kwargs: Any) -> Any:
                unit = unit_id(fn, args)
                try:
                    with _subtests(args) as failures:
                        result = await fn(*args, **kwargs)
                    if failures:
                        raise _combined(failures)
                except BaseException as exc:
                    if _passthrough(exc):
                        raise
                    _failed(meta, unit, exc)
                    return None
                record(meta, unit, 'QUARANTINED_PASS')
                return result

            wrapper = run_async
        else:
            @functools.wraps(fn)
            def run_sync(*args: Any, **kwargs: Any) -> Any:
                unit = unit_id(fn, args)
                try:
                    with _subtests(args) as failures:
                        result = fn(*args, **kwargs)
                    if failures:
                        raise _combined(failures)
                except BaseException as exc:
                    if _passthrough(exc):
                        raise
                    _failed(meta, unit, exc)
                    return None
                record(meta, unit, 'QUARANTINED_PASS')
                return result

            wrapper = run_sync
        wrapper.__quarantine__ = dict(meta)
        return wrapper

    return decorate


def child_environment(env: dict[str, str], rows: str | os.PathLike, prefix: str = '') -> dict[str, str]:
    """A runner's child env: quarantine rows go to `rows` (forwarded later), ids get `prefix`."""
    child = dict(env)
    child[QUARANTINE_PROGRESS_ENV] = str(rows)
    if prefix:
        child[UNIT_PREFIX_ENV] = prefix
    else:
        child.pop(UNIT_PREFIX_ENV, None)
    return child


def forward(rows: str | os.PathLike, *, target: str | os.PathLike | None = None,
            log: str = '') -> list[dict]:
    """Copy a child's valid QUARANTINED_* rows into the gate's progress file (if it has one)."""
    found = progress.quarantined(progress.read_new(rows)[0])
    destination = target or os.environ.get(progress.ENV)
    if destination:
        for value in found:
            progress.report(value['unit'], value['status'], scope=value['scope'], detail=value['detail'],
                            log=log or value['log'], case=value['case'], quarantine=value['quarantine'],
                            path=destination)
    return found
