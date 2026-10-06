"""Run the image's actual joined installer with offline process fixtures."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

INSTALLER = r"""
import json,os,shutil,subprocess,sys,time
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
        if os.environ.get('IMAGE_INSTALL_ROLLUP_SOURCE'):
            shutil.copytree(os.environ['IMAGE_INSTALL_ROLLUP_SOURCE'],cwd/'node_modules/rollup')
            if os.environ['IMAGE_INSTALL_NATIVE_STATE'] in ('present','broken'):
                native=cwd/'node_modules'/os.environ['IMAGE_INSTALL_NATIVE_NAME']
                shutil.copytree(os.environ['IMAGE_INSTALL_NATIVE_SOURCE'],native)
                if os.environ['IMAGE_INSTALL_NATIVE_STATE']=='broken':
                    for binding in native.glob('*.node'):
                        binding.write_bytes(b'broken native library')
        (fixture/'javascript.finished').touch()
        raise SystemExit(int(os.environ['IMAGE_INSTALL_JS_STATUS']))
    elif args[:6]==['install','--ignore-scripts','--no-save','--package-lock=false','--no-audit','--no-fund']:
        assert args[6:]==[os.environ['IMAGE_INSTALL_NATIVE_NAME']+'@'+os.environ['IMAGE_INSTALL_ROLLUP_VERSION']]
        assert cwd!=fixture/'checkout', 'native repair must not resolve the workspace again'
        if os.environ['IMAGE_INSTALL_NATIVE_STATE']=='offline':
            raise SystemExit(43)
        # Exercise npm's real isolated extraction using the exact installed native
        # package as an offline registry artifact, rather than a dummy module.
        raise SystemExit(subprocess.call([os.environ['IMAGE_INSTALL_REAL_NPM'],*args[:6],os.environ['IMAGE_INSTALL_NATIVE_TARBALL']]))
    elif args==['cache','clean','--force']:
        assert (fixture/'javascript.finished').exists() and (fixture/'python.finished').exists()
        shutil.rmtree(fixture/'home/.npm/_cacache')
    else:
        raise SystemExit('unexpected npm invocation')
elif tool=='npx':
    assert args==['prisma','generate'] and cwd.name=='back-end'
    (cwd/'prisma-generated').touch()
elif tool=='node':
    assert args==['-']
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
    for name in ("npm", "npx", "python3", "node"):
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


@pytest.mark.parametrize("state", ["missing", "present", "broken", "offline", "wrong-version"])
def test_cloudbench_image_build_loads_actual_rollup_native_without_version_or_manifest_changes(tmp_path, state):
    node, npm = shutil.which("node"), shutil.which("npm")
    assert node and npm, "image installer coverage requires the installed Node/npm toolchain"
    # Ask the real loader which binding this host uses, preserving Rollup's own
    # OS/architecture/libc selection instead of duplicating a platform table.
    artifact = json.loads(
        subprocess.check_output(
            [
                node,
                "-e",
                r"""
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const manifest = require.resolve('rollup/package.json', { paths: [path.resolve('front-end')] });
const original = Module._load;
let native;
Module._load = function(name, parent, ...rest) {
    if (name.startsWith('@rollup/rollup-')) native = { name, source: path.dirname(Module._resolveFilename(name + '/package.json', parent)) };
    return original.call(this, name, parent, ...rest);
};
require(path.join(path.dirname(manifest), 'dist/native.js'));
console.log(JSON.stringify({ rollup: path.dirname(manifest), version: JSON.parse(fs.readFileSync(manifest)).version, ...native }));
""",
            ],
            cwd=ROOT,
            text=True,
        )
    )
    assert artifact["name"].startswith("@rollup/rollup-")
    tarball = tmp_path / "native.tgz"
    native_artifact = tmp_path / "native-artifact"
    shutil.copytree(artifact["source"], native_artifact)
    if state == "wrong-version":
        package = native_artifact / "package.json"
        metadata = json.loads(package.read_text())
        metadata["version"] = "0.0.0"
        package.write_text(json.dumps(metadata))
    with tarfile.open(tarball, "w:gz") as archive:
        archive.add(native_artifact, arcname="package")
    work = tmp_path / "checkout"
    for name in ("back-end", "front-end", "agents"):
        (work / name).mkdir(parents=True, exist_ok=True)
    manifests = {
        "package.json": '{"private":true,"workspaces":["front-end","back-end"]}',
        "package-lock.json": '{"lockfileVersion":3,"packages":{}}',
        "front-end/package.json": '{"name":"native-frontend"}',
        "front-end/package-lock.json": '{"lockfileVersion":3,"packages":{}}',
    }
    for name, contents in manifests.items():
        (work / name).write_text(contents)
    home = tmp_path / "home"
    for name in (".npm/_cacache/download", ".npm/_logs/install.log"):
        target = home / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.touch()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name in ("npm", "npx", "python3"):
        tool = bin_dir / name
        tool.write_text(f"#!{sys.executable}\n" + INSTALLER)
        tool.chmod(0o755)
    env = {
        **os.environ,
        "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
        "IMAGE_INSTALL_FIXTURE_ROOT": str(tmp_path),
        "IMAGE_INSTALL_JS_STATUS": "0",
        "IMAGE_INSTALL_PY_STATUS": "0",
        "IMAGE_INSTALL_ROLLUP_SOURCE": artifact["rollup"],
        "IMAGE_INSTALL_ROLLUP_VERSION": artifact["version"],
        "IMAGE_INSTALL_NATIVE_SOURCE": artifact["source"],
        "IMAGE_INSTALL_NATIVE_NAME": artifact["name"],
        "IMAGE_INSTALL_NATIVE_TARBALL": str(tarball),
        "IMAGE_INSTALL_NATIVE_STATE": state,
        "IMAGE_INSTALL_REAL_NPM": npm,
        "NPM_CONFIG_USERCONFIG": str(home / ".npmrc"),
        "NPM_CONFIG_CACHE": str(home / ".npm"),
        "NPM_CONFIG_OFFLINE": "true",
    }
    result = subprocess.run(
        [shutil.which("bash"), str(ROOT / "scripts/cloudbench-install-image-deps.sh")],
        cwd=work,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == (0 if state in ("missing", "present") else 1), result.stdout + result.stderr
    if state in ("missing", "present"):
        (work / "input.js").write_text("export const answer = 42;\n")
        build = subprocess.run(
            [
                node,
                "-e",
                "require('rollup').rollup({input:'input.js'}).then(b=>b.generate({format:'es'})).then(r=>{if(!r.output[0].code.includes('42'))process.exit(1)})",
            ],
            cwd=work,
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert build.returncode == 0, build.stdout + build.stderr
    commands = [json.loads(line) for line in (tmp_path / "commands.jsonl").read_text().splitlines()]
    repairs = [args for args in commands if args[:3] == ["npm", "install", "--ignore-scripts"]]
    assert bool(repairs) == (state in ("missing", "offline", "wrong-version"))
    for name, contents in manifests.items():
        assert (work / name).read_text() == contents
    assert json.loads((work / "node_modules/rollup/package.json").read_text())["version"] == artifact["version"]
    if state in ("broken", "offline", "wrong-version"):
        assert not (work / "back-end/prisma-generated").exists()
        assert not (work / "back-end/node_modules/.hoisted-to-root").exists()
        return
