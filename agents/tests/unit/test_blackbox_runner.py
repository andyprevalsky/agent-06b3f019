import asyncio
import importlib.util
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
