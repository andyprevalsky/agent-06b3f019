import os
import subprocess
from pathlib import Path

import pytest

from tests.env_defaults import UNSIGNED_FIXTURE_GIT_CONFIG, apply_test_env_defaults

GIT_ENV_KEYS = (
    "GIT_CONFIG_COUNT",
    *(f"GIT_CONFIG_{kind}_{i}" for kind in ("KEY", "VALUE") for i in range(len(UNSIGNED_FIXTURE_GIT_CONFIG))),
)


@pytest.fixture
def signing_host(tmp_path: Path, monkeypatch) -> Path:
    """A host whose global git config signs every commit with an unreachable signer."""
    for key in GIT_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    global_config = tmp_path / "gitconfig"
    global_config.write_text(
        "[user]\n\tname = Fixture\n\temail = fixture@example.com\n\tsigningkey = /nonexistent/key\n"
        '[gpg]\n\tformat = ssh\n[gpg "ssh"]\n\tprogram = /nonexistent/signer\n'
        "[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n"
    )
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_config))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    repo = tmp_path / "fixture"
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    (repo / "file").write_text("x\n")
    subprocess.run(["git", "-C", str(repo), "add", "file"], check=True)
    return repo


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=30)


def test_fixture_commits_and_tags_never_reach_the_host_signer(signing_host: Path):
    assert _git(signing_host, "commit", "-qm", "fixture").returncode != 0, "fixture host must require signing"

    apply_test_env_defaults()

    commit = _git(signing_host, "commit", "-qm", "fixture")
    assert commit.returncode == 0, commit.stderr
    tag = _git(signing_host, "tag", "-a", "v0", "-m", "fixture")
    assert tag.returncode == 0, tag.stderr


def test_explicit_git_config_injection_is_not_overridden(signing_host: Path, monkeypatch):
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "core.abbrev")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "12")

    apply_test_env_defaults()

    assert _git(signing_host, "config", "core.abbrev").stdout.strip() == "12"
    assert "GIT_CONFIG_KEY_1" not in os.environ
    assert _git(signing_host, "commit", "-qm", "fixture").returncode != 0
