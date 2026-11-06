"""Security floors for runtimes and certificate stores used by Rose services."""

import asyncio
import json
import re
import sys
from pathlib import Path

from _result import Result as BlackboxResult


ROOT = Path(__file__).resolve().parents[3]
NODE_FLOOR = "22.23.4"


def _text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def _package(path: str) -> dict:
    return json.loads(_text(path))


def test_native_node_services_pin_patched_runtime() -> None:
    for path in (
        "package.json",
        "back-end/package.json",
        "front-end/package.json",
        "docs/package.json",
    ):
        assert _package(path).get("engines", {}).get("node") == NODE_FLOOR, path
    assert _text(".nvmrc").strip() == NODE_FLOOR


def test_container_node_runtimes_and_system_ca_store_are_patched() -> None:
    for path in ("Dockerfile.cloudbench", "Dockerfile.cloudbench-warm"):
        text = _text(path)
        assert f"FROM node:{NODE_FLOOR}-bookworm AS native-base" in text, path
        assert "ca-certificates" in text, path

    for path in (
        "agents/Dockerfile",
        "e2b-templates/claude-code/e2b.Dockerfile",
        "e2b-templates/codex-code/e2b.Dockerfile",
    ):
        text = _text(path)
        assert "setup_22.x" in text, path
        assert "setup_20.x" not in text, path
        assert "ca-certificates" in text, path

    shipper = _text("observability/fly-log-shipper/Dockerfile")
    assert re.search(r"apt-get install[^\n]*ca-certificates", shipper), shipper


def test_python_certificate_bundle_has_security_floor() -> None:
    requirements = _text("agents/requirements.txt").splitlines()
    assert "certifi>=2026.10.19" in {line.strip() for line in requirements}


def test_ci_and_ephemeral_gate_runtimes_pin_patched_releases() -> None:
    for path in (
        ".github/workflows/chat-lifecycle-ratchet.yml",
        ".github/workflows/deploy-agents.yml",
        ".github/workflows/download-egress.yml",
    ):
        pins = re.findall(r'node-version:\s*["\']?([^\s"\']+)', _text(path))
        assert pins and set(pins) == {NODE_FLOOR}, (path, pins)

    assert "FROM node:22.23.4-bookworm-slim AS node" in _text(
        "scripts/tests/cloudbench-controller-linux.Dockerfile"
    )
    assert 'GATE_NODE_VERSION="${GATE_NODE_VERSION:-v24.22.1}"' in _text(
        "scripts/run-cloudbench-controller-gate"
    )


async def run_all_tests() -> bool:
    print("structural-runtime-security tests:")
    result = BlackboxResult()
    result.record("native_node_services_pin_patched_runtime", test_native_node_services_pin_patched_runtime)
    result.record(
        "container_node_runtimes_and_system_ca_store_are_patched",
        test_container_node_runtimes_and_system_ca_store_are_patched,
    )
    result.record("python_certificate_bundle_has_security_floor", test_python_certificate_bundle_has_security_floor)
    result.record(
        "ci_and_ephemeral_gate_runtimes_pin_patched_releases",
        test_ci_and_ephemeral_gate_runtimes_pin_patched_releases,
    )
    return result.all_passed


if __name__ == "__main__":
    passed = asyncio.run(run_all_tests())
    sys.exit(0 if passed else 1)
