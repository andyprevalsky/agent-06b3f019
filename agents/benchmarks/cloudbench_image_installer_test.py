"""Run the image's actual joined installer with offline process fixtures."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

INSTALLER = r"""
import json,os,shutil,sys,time
from pathlib import Path
fixture=Path(os.environ['IMAGE_INSTALL_FIXTURE_ROOT'])
cwd=Path.cwd()
tool=Path(sys.argv[0]).name
args=sys.argv[1:]
with (fixture/'commands.jsonl').open('a') as log:
    log.write(json.dumps([tool,*args])+'\n')
def meet_peer(kind):
    (fixture/(kind+'.started')).write_text(str(os.getppid()))
    peer=fixture/(('python' if kind=='javascript' else 'javascript')+'.started')
    deadline=time.monotonic()+15
    while not peer.exists():
        if time.monotonic()>=deadline:
            raise SystemExit('installers were serialized')
        time.sleep(.01)
if tool=='npm':
    if args[:2]==['config','set']:
        with (fixture/'home/.npmrc').open('a') as f:
            f.write(args[2]+'='+args[3]+'\n')
    elif args==['config','get','cache']:
        print(fixture/'home/.npm')
    elif args==['install','--no-audit','--no-fund']:
        meet_peer('javascript')
        (cwd/'node_modules').mkdir(exist_ok=True)
        (cwd/'node_modules/installed.js').write_text('installed dependency')
        (fixture/'javascript.finished').touch()
        raise SystemExit(int(os.environ['IMAGE_INSTALL_JS_STATUS']))
    elif args==['cache','clean','--force']:
        assert (fixture/'javascript.finished').exists() and (fixture/'python.finished').exists()
        shutil.rmtree(fixture/'home/.npm/_cacache')
    else:
        raise SystemExit('unexpected npm invocation')
elif tool=='npx':
    assert args==['prisma','generate'] and cwd.name=='back-end'
    (cwd/'prisma-generated').touch()
elif tool=='python3':
    assert args==['-m','venv','agents/venv']
    meet_peer('python')
    pip=cwd/'agents/venv/bin/pip'
    pip.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(sys.argv[0],pip)
    pip.chmod(0o755)
elif tool=='pip':
    assert os.environ.get('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD')=='1'
    if args==['install','--upgrade','pip']:
        pass
    elif args==['install','-r','agents/requirements.txt']:
        (cwd/'agents/venv/installed.py').write_text('installed dependency')
        (fixture/'python.finished').touch()
        raise SystemExit(int(os.environ['IMAGE_INSTALL_PY_STATUS']))
    else:
        raise SystemExit('unexpected pip invocation')
else:
    raise SystemExit('unexpected installer tool')
"""


@pytest.mark.parametrize("javascript,python", [(0, 0), (37, 0), (0, 41), (37, 41)])
def test_cloudbench_image_build_joined_installer_keeps_artifacts_and_waits_both(tmp_path, javascript, python):
    work = tmp_path / "checkout"
    (work / "back-end").mkdir(parents=True)
    (work / "agents").mkdir()
    home = tmp_path / "home"
    retained = {
        ".cache/prisma/engine": "engine",
        ".cache/ms-playwright/browser": "browser",
        ".npm/_npx/tool/index.js": "cached executable",
    }
    disposable = {".npm/_cacache/download": "package tarball", ".npm/_logs/install.log": "download log"}
    for name, content in {**retained, **disposable}.items():
        target = home / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name in ("npm", "npx", "python3"):
        executable = bin_dir / name
        executable.write_text(f"#!{sys.executable}\n" + INSTALLER)
        executable.chmod(0o755)
    process = subprocess.Popen(
        [shutil.which("bash"), str(ROOT / "scripts/cloudbench-install-image-deps.sh")],
        cwd=work,
        env={
            **os.environ,
            "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
            "IMAGE_INSTALL_FIXTURE_ROOT": str(tmp_path),
            "IMAGE_INSTALL_JS_STATUS": str(javascript),
            "IMAGE_INSTALL_PY_STATUS": str(python),
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout, stderr = process.communicate(timeout=30)
    assert process.returncode == (0 if javascript == python == 0 else 1), stdout + stderr
    for kind in ("javascript", "python"):
        assert (tmp_path / f"{kind}.started").exists()
        assert (tmp_path / f"{kind}.finished").exists()
        # Each marker names the actual background shell; an exited installer
        # must not leave its sibling shell running after the owner returns.
        pid = int((tmp_path / f"{kind}.started").read_text())
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    if javascript or python:
        assert not (work / "back-end/node_modules/.hoisted-to-root").exists()
        return
    assert (work / "node_modules/installed.js").read_text() == "installed dependency"
    assert (work / "agents/venv/installed.py").read_text() == "installed dependency"
    assert (work / "back-end/prisma-generated").exists()
    assert (work / "back-end/node_modules/.hoisted-to-root").exists()
    assert (work / "agents/node_modules/.hoisted-to-root").exists()
    for name, content in retained.items():
        assert (home / name).read_text() == content
    assert not (home / ".npm/_cacache").exists()
    assert not (home / ".npm/_logs").exists()
    assert (home / ".npmrc").read_text().splitlines() == [
        "fetch-retries=5",
        "fetch-retry-mintimeout=20000",
        "fetch-retry-maxtimeout=120000",
        "fetch-timeout=600000",
    ]
    commands = [json.loads(line) for line in (tmp_path / "commands.jsonl").read_text().splitlines()]
    assert ["npm", "install", "--no-audit", "--no-fund"] in commands
    assert ["npx", "prisma", "generate"] in commands
    assert ["pip", "install", "--upgrade", "pip"] in commands
    assert ["pip", "install", "-r", "agents/requirements.txt"] in commands
