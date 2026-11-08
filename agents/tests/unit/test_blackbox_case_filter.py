"""BLACKBOX_CASE_FUNCTIONS: the new-test stability check reruns only changed blackbox cases.

Unset (the normal gate) every registered case runs. Set, only the named test
functions run; every other case is omitted — never executed and never counted
as a pass — and the runner labels the domain a partial run.
"""

import asyncio
import importlib.util
import os
import sys
from pathlib import Path

import pytest

from tests.unit._blackbox_harness import blackbox_harness as _harness

AGENTS = Path(__file__).resolve().parents[2]
CASE_FILTER_ENV = "BLACKBOX_CASE_FUNCTIONS"
CASE_RECEIPT_ENV = "BLACKBOX_CASE_RECEIPT"
_test_utils = None


def BlackboxResult():
    return _test_utils.BlackboxResult()


@pytest.fixture(autouse=True)
def blackbox_harness():
    """The blackbox harness for one test (see tests/unit/_blackbox_harness.py)."""
    global _test_utils
    with _harness() as module:
        _test_utils = module
        assert (_test_utils.CASE_FILTER_ENV, _test_utils.CASE_RECEIPT_ENV) == (CASE_FILTER_ENV, CASE_RECEIPT_ENV)
        os.environ.pop(CASE_FILTER_ENV, None)
        os.environ.pop(CASE_RECEIPT_ENV, None)
        try:
            yield
        finally:
            _test_utils = None


def _cases(ran):
    def test_alpha():
        ran.append("test_alpha")

    def test_beta():
        ran.append("test_beta")

    async def test_gamma():
        ran.append("test_gamma")

    return test_alpha, test_beta, test_gamma


def _run(result, alpha, beta, gamma):
    async def go():
        result.record("alpha", alpha)
        result.record("beta", beta)
        await result.record_async("gamma", gamma)

    asyncio.run(go())


def test_unset_filter_runs_every_case():
    ran = []
    result = BlackboxResult()
    _run(result, *_cases(ran))
    assert ran == ["test_alpha", "test_beta", "test_gamma"]
    assert result.summary() == {"passed": 3, "failed": 0, "total": 3}


def test_filter_runs_only_named_functions_and_omits_the_rest(monkeypatch, tmp_path):
    receipt = tmp_path / "ran.cases"
    monkeypatch.setenv(CASE_FILTER_ENV, "test_beta,test_gamma")
    monkeypatch.setenv(CASE_RECEIPT_ENV, str(receipt))
    ran = []
    result = BlackboxResult()
    _run(result, *_cases(ran))
    assert ran == ["test_beta", "test_gamma"]
    assert result.omitted == ["alpha"]
    assert receipt.read_text().split() == ["test_beta", "test_gamma"]


def test_omitted_cases_are_never_counted_as_passes(monkeypatch):
    monkeypatch.setenv(CASE_FILTER_ENV, "test_alpha")
    result = BlackboxResult()
    _run(result, *_cases([]))
    assert result.summary() == {"passed": 1, "failed": 0, "total": 1, "omitted": 2}


def test_an_empty_filter_runs_nothing_and_passes_nothing(monkeypatch):
    monkeypatch.setenv(CASE_FILTER_ENV, "")
    result = BlackboxResult()
    ran = []
    _run(result, *_cases(ran))
    assert ran == [] and result.passed == 0 and len(result.omitted) == 3


def test_select_keeps_filtered_cases_and_records_the_rest_omitted(monkeypatch):
    alpha, beta, gamma = _cases([])
    result = BlackboxResult()
    assert result.select([("a", alpha), ("b", beta)]) == [("a", alpha), ("b", beta)]
    monkeypatch.setenv(CASE_FILTER_ENV, "test_beta")
    assert result.select([("a", alpha), ("b", beta), ("g", gamma)]) == [("b", beta)]
    assert result.omitted == ["a", "g"]


def test_receipt_is_written_only_by_a_filtered_run(monkeypatch, tmp_path):
    receipt = tmp_path / "ran.cases"
    monkeypatch.setenv(CASE_RECEIPT_ENV, str(receipt))
    _run(BlackboxResult(), *_cases([]))
    assert not receipt.exists()


def _load_runner():
    path = AGENTS / "scripts" / "run_blackbox_tests.py"
    spec = importlib.util.spec_from_file_location("blackbox_runner_case_filter", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_runner_labels_a_filtered_domain_as_partial(monkeypatch, tmp_path):
    domain = tmp_path / "fixture.blackbox.py"
    domain.write_text(
        "from _test_utils import BlackboxResult\n\n"
        "def test_one():\n    pass\n\n"
        "def test_two():\n    pass\n\n"
        "async def run_all_tests():\n"
        "    r = BlackboxResult()\n"
        "    r.record('one', test_one)\n"
        "    r.record('two', test_two)\n"
        "    return r.all_passed\n"
    )
    runner = _load_runner()
    name, passed, message = asyncio.run(runner.run_single_domain(domain, "fixture"))
    assert (passed, message) == (True, "")
    monkeypatch.setenv(CASE_FILTER_ENV, "test_two")
    name, passed, message = asyncio.run(runner.run_single_domain(domain, "fixture"))
    assert passed and "partial" in message
