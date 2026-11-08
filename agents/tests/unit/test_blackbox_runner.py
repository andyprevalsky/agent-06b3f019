import asyncio
import importlib.util
import os
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


def test_sequential_domains_in_one_task_do_not_share_agent_speed(tmp_path: Path):
    """run_tests awaits every domain in one task, as here. A browser handler's
    unbalanced bind_agent_speed (safe in production: Temporal runs each activity
    in its own task) must not reach a later suite: rose then saw "standard"
    and skipped the agent-row speed lookup, so tiers were [None, None, None]."""
    runner = load_runner()
    binding_domain = tmp_path / "binding_speed.blackbox.py"
    binding_domain.write_text(
        "from providers.rose.speed import bind_agent_speed\n"
        "async def run_all_tests():\n"
        "    bind_agent_speed('fast')\n"
        "    return True\n"
    )
    observing_domain = tmp_path / "observing_speed.blackbox.py"
    observing_domain.write_text(
        "from providers.rose.speed import current_agent_speed\n"
        "async def run_all_tests():\n"
        "    return current_agent_speed() is None\n"
    )

    async def run_sequentially():
        return [
            await runner.run_single_domain(binding_domain, "binding-speed"),
            await runner.run_single_domain(observing_domain, "observing-speed"),
        ]

    results = asyncio.run(run_sequentially())
    assert [passed for _, passed, _ in results] == [True, True], results


def test_sequential_domains_do_not_share_httpx_mock_handler(tmp_path: Path):
    """A suite's leftover mock must not answer a later suite's loopback requests
    (it returned {} for real Chromium's /json/version)."""
    runner = load_runner()
    leaking_domain = tmp_path / "leaking_mock.blackbox.py"
    leaking_domain.write_text(
        "import httpx\n"
        "from helpers.httpx_capture import set_mock_handler\n"
        "async def run_all_tests():\n"
        "    set_mock_handler(lambda request: httpx.Response(200, json={}))\n"
        "    return True\n"
    )
    observing_domain = tmp_path / "observing_mock.blackbox.py"
    observing_domain.write_text(
        "import helpers.httpx_capture as capture\n"
        "async def run_all_tests():\n"
        "    return capture._mock_handler is None\n"
    )

    try:
        assert asyncio.run(runner.run_single_domain(leaking_domain, "leaking-mock"))[1]
        assert asyncio.run(runner.run_single_domain(observing_domain, "observing-mock"))[1]
    finally:
        from helpers.httpx_capture import clear_mock_handler

        clear_mock_handler()


def test_sequential_domains_do_not_share_environment(tmp_path: Path, monkeypatch):
    runner = load_runner()
    monkeypatch.setenv("BLACKBOX_RUNNER_KEPT", "original")
    monkeypatch.delenv("BLACKBOX_RUNNER_LEAKED", raising=False)
    leaking_domain = tmp_path / "leaking.blackbox.py"
    leaking_domain.write_text(
        "import os\n"
        "async def run_all_tests():\n"
        "    os.environ['BLACKBOX_RUNNER_LEAKED'] = '1'\n"
        "    os.environ['BLACKBOX_RUNNER_KEPT'] = 'overwritten'\n"
        "    del os.environ['BLACKBOX_RUNNER_KEPT']\n"
        "    return True\n"
    )
    observing_domain = tmp_path / "observing.blackbox.py"
    observing_domain.write_text(
        "import os\n"
        "async def run_all_tests():\n"
        "    return 'BLACKBOX_RUNNER_LEAKED' not in os.environ"
        " and os.environ.get('BLACKBOX_RUNNER_KEPT') == 'original'\n"
    )

    assert asyncio.run(runner.run_single_domain(leaking_domain, "leaking"))[1]
    assert asyncio.run(runner.run_single_domain(observing_domain, "observing"))[1]
    assert "BLACKBOX_RUNNER_LEAKED" not in os.environ
    assert os.environ["BLACKBOX_RUNNER_KEPT"] == "original"


def test_import_time_env_defaults_survive_domain_restore(tmp_path: Path, monkeypatch):
    """A cached module's import-time env default must outlive the domain that first imported it."""
    runner = load_runner()
    default_key = "BLACKBOX_RUNNER_IMPORT_DEFAULT"
    module_name = "blackbox_runner_env_default_mod"
    for key in (default_key, "BLACKBOX_RUNNER_TEST_WRITE", "BLACKBOX_RUNNER_DOMAIN_MODULE_WRITE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.syspath_prepend(str(tmp_path))
    (tmp_path / f"{module_name}.py").write_text(f"import os\nos.environ.setdefault('{default_key}', '300')\n")
    importing_domain = tmp_path / "importing.blackbox.py"
    importing_domain.write_text(
        "import os\n"
        "os.environ['BLACKBOX_RUNNER_DOMAIN_MODULE_WRITE'] = '1'\n"
        "async def run_all_tests():\n"
        f"    import {module_name}\n"
        "    os.environ['BLACKBOX_RUNNER_TEST_WRITE'] = '1'\n"
        f"    return os.environ.get('{default_key}') == '300'\n"
    )
    observing_domain = tmp_path / "observing.blackbox.py"
    observing_domain.write_text(
        "import os\n"
        "async def run_all_tests():\n"
        f"    import {module_name}\n"
        f"    return os.environ.get('{default_key}') == '300'"
        " and 'BLACKBOX_RUNNER_TEST_WRITE' not in os.environ"
        " and 'BLACKBOX_RUNNER_DOMAIN_MODULE_WRITE' not in os.environ\n"
    )

    try:
        assert asyncio.run(runner.run_single_domain(importing_domain, "importing"))[1]
        assert asyncio.run(runner.run_single_domain(observing_domain, "observing"))[1]
    finally:
        sys.modules.pop(module_name, None)
        os.environ.pop(default_key, None)


def _write_cached_default_module(tmp_path: Path, module_name: str, key: str) -> None:
    (tmp_path / f"{module_name}.py").write_text(f"import os\nos.environ.setdefault('{key}', '300')\n")


def _observing_domain(tmp_path: Path, module_name: str, key: str) -> Path:
    domain = tmp_path / "observing.blackbox.py"
    domain.write_text(
        "import os\n"
        "async def run_all_tests():\n"
        f"    import {module_name}\n"
        f"    return os.environ.get('{key}') == '300'\n"
    )
    return domain


def test_domain_module_override_keeps_cached_import_default(tmp_path: Path, monkeypatch):
    """A domain file overwriting a cached module's default at module scope must not delete that default."""
    runner = load_runner()
    key = "BLACKBOX_RUNNER_OVERRIDDEN_DEFAULT"
    module_name = "blackbox_runner_overridden_default_mod"
    monkeypatch.delenv(key, raising=False)
    monkeypatch.syspath_prepend(str(tmp_path))
    _write_cached_default_module(tmp_path, module_name, key)
    overriding_domain = tmp_path / "overriding.blackbox.py"
    overriding_domain.write_text(
        "import os\n"
        f"import {module_name}\n"
        f"os.environ['{key}'] = 'domain-override'\n"
        "async def run_all_tests():\n"
        f"    return os.environ.get('{key}') == 'domain-override'\n"
    )

    try:
        assert asyncio.run(runner.run_single_domain(overriding_domain, "overriding"))[1]
        assert asyncio.run(runner.run_single_domain(_observing_domain(tmp_path, module_name, key), "observing"))[1]
    finally:
        sys.modules.pop(module_name, None)
        os.environ.pop(key, None)


def test_failed_import_write_keeps_cached_import_default(tmp_path: Path, monkeypatch):
    """A module whose import fails after writing a key must not erase an earlier cached module's default."""
    runner = load_runner()
    key = "BLACKBOX_RUNNER_FAILED_IMPORT_DEFAULT"
    module_name = "blackbox_runner_failed_import_default_mod"
    broken_name = "blackbox_runner_failed_import_broken_mod"
    monkeypatch.delenv(key, raising=False)
    monkeypatch.syspath_prepend(str(tmp_path))
    _write_cached_default_module(tmp_path, module_name, key)
    (tmp_path / f"{broken_name}.py").write_text(
        f"import os\nos.environ['{key}'] = 'broken'\nraise RuntimeError('import failed')\n"
    )
    importing_domain = tmp_path / "importing.blackbox.py"
    importing_domain.write_text(
        "async def run_all_tests():\n"
        f"    import {module_name}\n"
        "    try:\n"
        f"        import {broken_name}\n"
        "    except RuntimeError:\n"
        "        return True\n"
        "    return False\n"
    )

    try:
        assert asyncio.run(runner.run_single_domain(importing_domain, "importing"))[1]
        assert broken_name not in sys.modules
        assert asyncio.run(runner.run_single_domain(_observing_domain(tmp_path, module_name, key), "observing"))[1]
    finally:
        sys.modules.pop(module_name, None)
        sys.modules.pop(broken_name, None)
        os.environ.pop(key, None)


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
