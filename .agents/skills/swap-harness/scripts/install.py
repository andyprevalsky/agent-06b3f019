#!/usr/bin/env python3
"""Install this standalone skill for Codex and Claude on the current box."""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path


def install(source: Path, home: Path) -> list[Path]:
    source = source.resolve()
    if not (source / "SKILL.md").is_file():
        raise ValueError("Source has no SKILL.md")
    canonical = home / ".local/share/boxes-skills/swap-harness"
    links = [home / ".agents/skills/swap-harness", home / ".claude/skills/swap-harness"]
    for link in links:
        if link.is_symlink():
            if link.resolve() != canonical.resolve():
                raise ValueError(f"Existing skill link points elsewhere: {link}")
        elif link.exists():
            raise ValueError(f"Existing skill directory requires reconciliation: {link}")
    if canonical.is_symlink():
        raise ValueError(f"Canonical skill must be a regular directory: {canonical}")
    if canonical.exists() and not (canonical / "SKILL.md").is_file():
        raise ValueError(f"Unexpected canonical directory: {canonical}")
    if source != canonical.resolve():
        shutil.copytree(source, canonical, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for link in links:
        link.parent.mkdir(parents=True, exist_ok=True)
        if not link.is_symlink():
            link.symlink_to(canonical, target_is_directory=True)
    return links


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home())
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1]
    for link in install(source, args.home.expanduser().resolve()):
        print(link)


if __name__ == "__main__":
    main()
