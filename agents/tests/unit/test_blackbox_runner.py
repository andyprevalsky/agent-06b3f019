import asyncio
import importlib.util
import os
import sys
from pathlib import Path

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
