import asyncio
import importlib.util
import sys
from pathlib import Path

import pytest
import structlog.contextvars


def load_runner():
    path = Path(__file__).resolve().parents[2] / "scripts" / "run_blackbox_tests.py"
    spec = importlib.util.spec_from_file_location("blackbox_runner_for_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_sequential_domains_do_not_share_structlog_context(tmp_path: Path):
    runner = load_runner()
    leaking_domain = tmp_path / "leaking.blackbox.py"
    leaking_domain.write_text(
        "import structlog.contextvars\n"
        "async def run_all_tests():\n"
        "    structlog.contextvars.bind_contextvars(root_agent_id='leaked-root')\n"
        "    return True\n"
    )
    observing_domain = tmp_path / "observing.blackbox.py"
    observing_domain.write_text(
        "import structlog.contextvars\n"
        "async def run_all_tests():\n"
        "    return 'root_agent_id' not in structlog.contextvars.get_contextvars()\n"
    )

    assert asyncio.run(runner.run_single_domain(leaking_domain, "leaking"))[1]
    assert asyncio.run(runner.run_single_domain(observing_domain, "observing"))[1]
    assert structlog.contextvars.get_contextvars() == {}


def _run_main(runner, monkeypatch, argv: list[str], started: list[tuple]) -> None:
    async def fake_run_tests(domain_filters, concurrency):
        started.append((domain_filters, concurrency))
        return 0

    monkeypatch.setattr(runner, "run_tests", fake_run_tests)
    monkeypatch.setattr(sys, "argv", ["run_blackbox_tests.py", *argv])
    runner.main()


@pytest.mark.parametrize("argv", [["--concurency", "5"], ["workflow", "--verbose"], ["--concurrency"]])
def test_unrecognized_or_incomplete_option_exits_before_running_any_domain(monkeypatch, argv):
    started: list[tuple] = []
    with pytest.raises(SystemExit) as exited:
        _run_main(load_runner(), monkeypatch, argv, started)
    assert exited.value.code == 2
    assert started == []


@pytest.mark.parametrize("flag", ["-h", "--help"])
def test_help_prints_usage_without_running_any_domain(monkeypatch, capsys, flag):
    started: list[tuple] = []
    _run_main(load_runner(), monkeypatch, [flag], started)
    assert started == []
    assert "--concurrency" in capsys.readouterr().out


def test_domains_and_concurrency_reach_the_suite_runner(monkeypatch):
    started: list[tuple] = []
    with pytest.raises(SystemExit) as exited:
        _run_main(load_runner(), monkeypatch, ["workflow", "--concurrency", "4", "web-search"], started)
    assert exited.value.code == 0
    assert started == [(["workflow", "web-search"], 4)]
