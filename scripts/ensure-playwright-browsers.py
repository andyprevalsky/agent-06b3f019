#!/usr/bin/env python3
"""Ensure both installed Playwright runtimes keep their own Chromium assets."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys


BROWSER_BINARIES = {
    "chrome", "chrome.exe", "Chromium", "chrome-headless-shell",
    "chrome-headless-shell.exe", "headless_shell", "ffmpeg-linux", "ffmpeg-mac",
    "ffmpeg-win64.exe",
}


def command(argv: list[str], root: Path, *, timeout: int = 60) -> str:
    result = subprocess.run(argv, cwd=root, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"Playwright browser preflight command failed (exit {result.returncode})")
    return result.stdout


def installed(cli: list[str], primary: Path, root: Path) -> bool:
    output = command([*cli, "install", "--dry-run", "chromium"], root)
    locations = [Path(p.strip()) for p in re.findall(r"^\s*Install location:\s*(.+)$", output, re.M)]
    if not locations:
        raise RuntimeError("Playwright reported no required Chromium installation locations")
    if not primary.is_file() or not primary.stat().st_mode & 0o111:
        return False
    for location in locations:
        if not (location / "INSTALLATION_COMPLETE").is_file():
            return False
        # A completed marker alone cannot hide a removed headless-shell executable.
        if not any(p.is_file() and p.stat().st_mode & 0o111
                   for name in BROWSER_BINARIES for p in location.rglob(name)):
            return False
    return True


def ensure(root: Path) -> None:
    python_primary = command([sys.executable, "-c",
        "from playwright.sync_api import sync_playwright; "
        "p=sync_playwright().start(); print(p.chromium.executable_path); p.stop()"], root).strip()
    node = json.loads(command(["node", "-e", """
const {createRequire}=require('node:module');
const path=require('node:path');
const r=createRequire(path.join(process.argv[1],'front-end/package.json'));
const pkgPath=r.resolve('@playwright/test/package.json');
const pkg=r(pkgPath); const bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin.playwright;
console.log(JSON.stringify({cli:path.resolve(path.dirname(pkgPath),bin),
  executable:r('@playwright/test').chromium.executablePath()}));
""", str(root)], root))
    runtimes = [([sys.executable, "-m", "playwright"], Path(python_primary)),
                (["node", node["cli"]], Path(node["executable"]))]
    for cli, primary in runtimes:
        if not installed(cli, primary, root):
            print(f"Installing Chromium assets for {'Python' if cli[0] == sys.executable else 'Node'} Playwright", flush=True)
            command([*cli, "install", "chromium"], root, timeout=1800)
    # An installer may prune shared-cache revisions. Neither runtime can be assumed ready.
    if not all(installed(cli, primary, root) for cli, primary in runtimes):
        raise RuntimeError("Playwright Chromium assets are still missing after installation")
    print("Python and Node Playwright Chromium assets are ready", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    try:
        ensure(args.root.resolve(strict=True))
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Browser bootstrap refused: {error}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
