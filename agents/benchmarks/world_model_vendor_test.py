"""The isolated world model installs its vendored experiential wheel, never the removed upstream URL.

The experientiallabs organization disappeared by 2026-10-12, breaking every
uncached install of the pinned git requirement. The pin is now a reproducible
wheel beside the requirements file. Run by the WMH blackbox gate.
"""

import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WHEEL = "experiential-0.7.158+rose.bf75987e-py3-none-any.whl"
PIN = "experiential==0.7.158+rose.bf75987e"


def test_world_model_requirements_use_only_the_vendored_wheel():
    text = (ROOT / "agents/requirements-world-model.txt").read_text()
    lines = [line.strip() for line in text.splitlines()]
    assert "experientiallabs" not in text
    assert "--find-links ./vendor/world-model" in lines and PIN in lines
    vendor = ROOT / "agents/vendor/world-model"
    assert sorted(path.name for path in vendor.glob("*.whl")) == [WHEEL]
    digest = hashlib.sha256((vendor / WHEEL).read_bytes()).hexdigest()
    assert f"sha256: {digest}" in (vendor / "SOURCES.txt").read_text(), "vendored bytes differ from SOURCES.txt"
    setup = (ROOT / "scripts/setup-world-model.sh").read_text()
    assert "dist.version=='0.7.158+rose.bf75987e'" in setup and "vcs_info" not in setup


def test_vendored_world_model_wheel_resolves_offline_beside_its_requirements(tmp_path):
    checkout = tmp_path / "checkout"
    (checkout / "agents/vendor/world-model").mkdir(parents=True)
    shutil.copy2(ROOT / "agents/vendor/world-model" / WHEEL, checkout / "agents/vendor/world-model" / WHEEL)
    requirements = checkout / "agents/requirements-world-model.txt"
    requirements.write_text(f"--find-links ./vendor/world-model\n{PIN}\n")
    for cwd, path in ((checkout, "agents/requirements-world-model.txt"), (checkout / "agents", requirements.name),
                      (tmp_path, str(requirements))):
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--dry-run", "--no-deps", "--no-index", "--ignore-installed",
             "--disable-pip-version-check", "--python-version", "3.12", "--only-binary=:all:",
             # Resolution only: the real install runs in the isolated Python 3.12 environment.
             "--ignore-requires-python",
             "--target", str(tmp_path / "target"), "-r", path],
            cwd=cwd, capture_output=True, text=True, timeout=120,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert "Would install experiential-0.7.158+rose.bf75987e" in result.stdout, result.stdout
