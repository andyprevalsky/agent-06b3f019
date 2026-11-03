"""Run the image's actual joined installer with offline process fixtures."""

from __future__ import annotations

import json
from functools import cache
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
        if os.environ.get('IMAGE_INSTALL_GRAPH_SOURCE'):
            shutil.copytree(os.environ['IMAGE_INSTALL_GRAPH_SOURCE'],cwd,dirs_exist_ok=True)
            graph=json.loads(Path(os.environ['IMAGE_INSTALL_GRAPH_METADATA']).read_text())
            state=os.environ['IMAGE_INSTALL_NATIVE_STATE']
            for artifact in graph['natives']:
                native=cwd/artifact['relative']
                if state in ('missing','wrong-version') or (state in ('swc-missing','offline') and artifact['component']=='@swc/core'):
                    shutil.rmtree(native)
                elif state=='broken' and artifact['component']=='@swc/core':
                    for binding in native.rglob('*.node'):
                        binding.write_bytes(b'broken native library')
                elif state=='wrong-installed-version' and artifact['component']=='@swc/core':
                    package=native/'package.json'
                    metadata=json.loads(package.read_text())
                    metadata['version']='0.0.0'
                    package.write_text(json.dumps(metadata))
        (fixture/'javascript.finished').touch()
        raise SystemExit(int(os.environ['IMAGE_INSTALL_JS_STATUS']))
    elif args[:6]==['install','--ignore-scripts','--no-save','--package-lock=false','--no-audit','--no-fund']:
        graph=json.loads(Path(os.environ['IMAGE_INSTALL_GRAPH_METADATA']).read_text())
        artifact=next(a for a in graph['natives'] if args[6:]==[a['name']+'@'+a['version']])
        assert cwd!=fixture/'checkout', 'native repair must not resolve the workspace again'
        if os.environ['IMAGE_INSTALL_NATIVE_STATE']=='offline':
            raise SystemExit(43)
        # Exercise npm's real isolated extraction using the exact installed native
        # package as an offline registry artifact, rather than a dummy module.
        raise SystemExit(subprocess.call([os.environ['IMAGE_INSTALL_REAL_NPM'],*args[:6],artifact['tarball']]))
    elif args==['cache','clean','--force']:
        assert (fixture/'javascript.finished').exists() and (fixture/'python.finished').exists()
        shutil.rmtree(fixture/'home/.npm/_cacache')
    else:
        raise SystemExit('unexpected npm invocation')
elif tool=='npx':
    assert args==['prisma','generate'] and cwd.name=='back-end'
    (cwd/'prisma-generated').touch()
elif tool=='node':
    assert args in (['-'],['-','repair'],['-','verify'])
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


@pytest.fixture(scope="module")
def frontend_graph(tmp_path_factory):
    """Snapshot the real installed compiler graph and its loader-selected bindings."""
    node = shutil.which("node")
    assert node, "frontend compiler coverage requires the installed Node toolchain"
    graph = json.loads(
        subprocess.check_output(
            [
                node,
                "-e",
                r"""
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const packages = new Map(), bindings = new Map();
function packageRoot(file) {
    let dir = fs.statSync(file).isDirectory() ? file : path.dirname(file);
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
        if (dir === path.dirname(dir)) throw Error('Installed module has no package manifest');
        dir = path.dirname(dir);
    }
    return dir;
}
function visit(name, sourceParent, targetParent, optional = false) {
    const sources = Module._nodeModulePaths(sourceParent);
    const installed = sources.map(base => path.join(base, name, 'package.json'))
        .find(file => fs.existsSync(file));
    if (!installed) {
        if (optional) return;
        throw Error('Installed compiler dependency is missing: ' + name);
    }
    const source = path.dirname(fs.realpathSync(installed));
    const index = sources.findIndex(base => {
        const file = path.join(base, name, 'package.json');
        return fs.existsSync(file) && fs.realpathSync(file) === path.join(source, 'package.json');
    });
    if (index < 0) throw Error('Installed compiler graph escaped dependency lookup paths');
    const target = path.join(Module._nodeModulePaths(targetParent)[index], name);
    const key = source + '\0' + target;
    if (packages.has(key)) return;
    const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
    packages.set(key, { name: metadata.name, version: metadata.version, source,
        relative: path.relative('/fixture/checkout', target) });
    for (const dependency of Object.keys(metadata.dependencies || {})) visit(dependency, source, target);
    for (const dependency of Object.keys(metadata.optionalDependencies || {})) visit(dependency, source, target, true);
}
for (const name of ['vite', '@vitejs/plugin-react-swc', '@swc/core']) {
    visit(name, path.resolve('front-end'), '/fixture/checkout/front-end');
}
const original = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
    const resolved = original.call(this, request, parent, ...rest);
    if (parent?.filename && fs.existsSync(parent.filename) && !request.startsWith('.')) {
        const owner = packageRoot(parent.filename);
        const metadata = JSON.parse(fs.readFileSync(path.join(owner, 'package.json')));
        const name = Object.keys(metadata.optionalDependencies || {}).find(
            name => request === name || request.startsWith(name + '/'));
        if (name && metadata.optionalDependencies[name] === metadata.version) {
            const source = packageRoot(resolved);
            const artifact = [...packages.values()].find(entry => entry.source === source);
            const compiler = [...packages.values()].find(entry => entry.source === owner);
            if (artifact && compiler) bindings.set(compiler.relative + '/' + name, {
                name, version: metadata.version, source, relative: artifact.relative,
                parent: compiler.relative, component: metadata.name,
            });
        }
    }
    return resolved;
};
(async () => {
    for (const entry of packages.values()) {
        if (entry.name === 'rollup') require(path.join(entry.source, 'dist/native.js'));
        if (entry.name === '@swc/core') require(entry.source).transformSync('export const x = 1;');
        if (entry.name === 'esbuild') await require(entry.source).transform('export const x = 1;');
    }
    console.log(JSON.stringify({ packages: [...packages.values()], natives: [...bindings.values()] }));
})().catch(error => { console.error(error); process.exitCode = 1; });
""",
            ],
            cwd=ROOT,
            text=True,
        )
    )
    assert {entry["component"] for entry in graph["natives"]} == {"rollup", "@swc/core", "esbuild"}
    snapshot = tmp_path_factory.mktemp("frontend-compiler-graph")
    for entry in graph["packages"]:
        assert not entry["relative"].startswith("..")
        shutil.copytree(entry["source"], snapshot / entry["relative"], ignore=shutil.ignore_patterns("node_modules"))
    return graph, snapshot


@pytest.fixture(scope="module")
def frontend_native_archives(tmp_path_factory, frontend_graph):
    """Lazily prepare immutable inputs only for cases using valid archives."""
    @cache
    def prepare():
        graph, _ = frontend_graph
        root = tmp_path_factory.mktemp("frontend-native-archives")
        archives = []
        for number, artifact in enumerate(graph["natives"]):
            native = root / f"native-{number}"
            shutil.copytree(artifact["source"], native)
            tarball = root / f"native-{number}.tgz"
            with tarfile.open(tarball, "w:gz", compresslevel=1) as archive:
                archive.add(native, arcname="package")
            tarball.chmod(0o444)
            archives.append(tarball)
        return tuple(archives)

    return prepare


FRONTEND_BUILD = r"""
const path = require('node:path');
(async () => {
    const root = path.resolve('front-end');
    const vite = require(require.resolve('vite', { paths: [root] }));
    const configFile = path.join(root, 'vite.config.ts');
    const config = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, root, 'silent');
    if (!config) throw Error('Actual frontend configuration did not load');
    const swc = require(require.resolve('@swc/core', { paths: [root] }));
    if (!swc.transformSync('const Component = () => <main />;', { jsc: { parser: { syntax: 'ecmascript', jsx: true } } }).code.includes('Component')) {
        throw Error('Actual frontend compiler did not transform JSX');
    }
    const input = '\0frontend-owner-check';
    const output = await vite.build({ root, configFile, logLevel: 'silent',
        build: { write: false, minify: false, rollupOptions: { input } },
        plugins: [{ name: 'frontend-owner-check',
            resolveId(id) { if (id === input) return id; },
            load(id) { if (id === input) return 'globalThis.__frontendOwnerCheck = 43;'; },
        }],
    });
    if (!output.output.some(file => file.type === 'chunk' && file.code.includes('43'))) throw Error('Actual frontend did not build');
})().catch(error => { console.error(error); process.exitCode = 1; });
"""


@pytest.mark.parametrize(
    "state",
    [
        "missing",
        "swc-missing",
        "present",
        "broken",
        "offline",
        "wrong-version",
        "wrong-installed-version",
        "config-error",
        "config-helper",
    ],
)
def test_cloudbench_image_build_loads_actual_frontend_compilers_without_version_or_manifest_changes(
    tmp_path, state, frontend_graph, frontend_native_archives
):
    node, npm = shutil.which("node"), shutil.which("npm")
    assert node and npm, "frontend coverage requires the installed Node/npm toolchain"
    graph, snapshot = frontend_graph
    # Native artifacts come from the exact installed packages, with real npm
    # extraction offline. Neither package names nor host/libc selection are faked.
    artifacts = {**graph, "natives": []}
    for number, artifact in enumerate(graph["natives"]):
        if state == "wrong-version":
            # This case changes registry input, never the shared valid archives.
            native = tmp_path / f"native-{number}"
            shutil.copytree(artifact["source"], native)
            package = native / "package.json"
            metadata = json.loads(package.read_text())
            metadata["version"] = "0.0.0"
            package.write_text(json.dumps(metadata))
            tarball = tmp_path / f"native-{number}.tgz"
            with tarfile.open(tarball, "w:gz", compresslevel=1) as archive:
                archive.add(native, arcname="package")
        else:
            tarball = frontend_native_archives()[number]
        artifacts["natives"].append({**artifact, "tarball": str(tarball)})
    graph_file = tmp_path / "graph.json"
    graph_file.write_text(json.dumps(artifacts))
    work = tmp_path / "checkout"
    manifests = {}
    for relative in (
        "package.json",
        "back-end/package.json",
        "back-end/package-lock.json",
        "front-end/package.json",
        "front-end/package-lock.json",
        "agents/requirements.txt",
    ):
        source = ROOT / relative
        target = work / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
        manifests[relative] = source.read_bytes()
    (work / "package-lock.json").write_text('{"lockfileVersion":3,"packages":{}}')
    manifests["package-lock.json"] = (work / "package-lock.json").read_bytes()
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
        "IMAGE_INSTALL_GRAPH_SOURCE": str(snapshot),
        "IMAGE_INSTALL_GRAPH_METADATA": str(graph_file),
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
    producer_healthy = state in ("missing", "swc-missing", "present", "config-error", "config-helper")
    assert result.returncode == (0 if producer_healthy else 1), result.stdout + result.stderr
    # The dependency layer has only manifests. The real configuration and its
    # relative imports arrive with the later source COPY, then get verified.
    config = work / "front-end/vite.config.ts"
    shutil.copyfile(ROOT / "front-end/vite.config.ts", config)
    if state == "config-error":
        with config.open("a") as target:
            target.write("\nthrow new Error('Fixture frontend configuration rejected');\n")
    if state == "config-helper":
        with config.open("a") as target:
            target.write("\nimport './vite-helper';\n")
        (work / "front-end/vite-helper.ts").write_text("globalThis.__roseConfigHelper = 1;\n")
    commands_before_verify = (tmp_path / "commands.jsonl").read_bytes()
    healthy = producer_healthy and state != "config-error"
    if healthy:
        build_script = tmp_path / "frontend-build.cjs"
        build_script.write_text(FRONTEND_BUILD)
        build = subprocess.run([node, str(build_script)], cwd=work, env=env, capture_output=True, text=True, timeout=20)
        assert build.returncode == 0, build.stdout + build.stderr
    if producer_healthy:
        verified = subprocess.run(
            [shutil.which("bash"), str(ROOT / "scripts/cloudbench-install-image-deps.sh"), "--verify-frontend"],
            cwd=work,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert verified.returncode == (0 if healthy else 1), verified.stdout + verified.stderr
        assert (tmp_path / "commands.jsonl").read_bytes() == commands_before_verify
    commands = [json.loads(line) for line in (tmp_path / "commands.jsonl").read_text().splitlines()]
    repairs = [args for args in commands if args[:3] == ["npm", "install", "--ignore-scripts"]]
    assert bool(repairs) == (state in ("missing", "swc-missing", "offline", "wrong-version"))
    expected = {a["name"] + "@" + a["version"] for a in graph["natives"]}
    assert all(args[7] in expected for args in repairs)
    if state == "missing":
        assert {args[7] for args in repairs} == expected
    for name, contents in manifests.items():
        assert (work / name).read_bytes() == contents
    for package in graph["packages"]:
        installed = work / package["relative"] / "package.json"
        if installed.is_file():
            expected_version = (
                "0.0.0"
                if state == "wrong-installed-version"
                and any(
                    a["component"] == "@swc/core" and a["relative"] == package["relative"] for a in graph["natives"]
                )
                else package["version"]
            )
            assert json.loads(installed.read_text())["version"] == expected_version
    if not producer_healthy:
        assert not (work / "back-end/prisma-generated").exists()
        assert not (work / "back-end/node_modules/.hoisted-to-root").exists()
    else:
        assert (work / "back-end/prisma-generated").exists()


def test_vendored_python_wheels_install_offline_from_every_image_context(tmp_path):
    """A removed upstream repository cannot break image builds again.

    world-model-harness is vendored as a reproducible wheel. Its local version label never
    resolves from PyPI, whose unrelated 0.1.0 differs, and the requirements-relative
    `--find-links` works from the repository root and agents/ alike. Every image that installs
    agents/requirements.txt before copying the checkout must copy the wheel first.
    """
    import hashlib
    import re

    requirements = (ROOT / "agents/requirements.txt").read_text()
    lines = [line.strip() for line in requirements.splitlines()]
    assert "--find-links ./vendor" in lines
    assert "experientiallabs" not in requirements
    pins = [line for line in lines if re.fullmatch(r"[A-Za-z0-9_.-]+==[^=\s]+\+rose\.[0-9a-f]+", line)]
    assert pins == ["world-model-harness==0.1.0+rose.8e6d55dd"], pins

    # An open openai range made pip walk every newer release before reaching
    # browser-use's requirement; keep our exact openai pin inside the installed
    # browser-use requirement (0.13.10/0.13.11 pin openai exactly, 0.13.12+ declare
    # a range, so a fresh venv resolving the manifest's browser-use range must pass).
    from importlib.metadata import requires

    from packaging.requirements import Requirement

    openai_pin = next((line for line in lines if re.fullmatch(r"openai==[^\s;]+", line)), None)
    assert openai_pin, "agents/requirements.txt must pin openai exactly"
    browser_use_openai = [
        req
        for req in (Requirement(r) for r in requires("browser-use") or [])
        if req.name == "openai" and (req.marker is None or req.marker.evaluate({"extra": ""}))
    ]
    assert browser_use_openai, "browser-use must declare an openai requirement"
    assert all(
        req.specifier.contains(openai_pin.split("==", 1)[1], prereleases=True) for req in browser_use_openai
    ), (openai_pin, [str(req) for req in browser_use_openai])

    vendor = ROOT / "agents/vendor"
    sources = (vendor / "SOURCES.txt").read_text()
    wheels = sorted(path.name for path in vendor.glob("*.whl"))
    assert wheels == ["world_model_harness-0.1.0+rose.8e6d55dd-py3-none-any.whl"], wheels
    digest = hashlib.sha256((vendor / wheels[0]).read_bytes()).hexdigest()
    assert f"sha256: {digest}" in sources, "vendored wheel bytes differ from SOURCES.txt"

    agents_dockerfile = (ROOT / "agents/Dockerfile").read_text()
    assert agents_dockerfile.index("COPY vendor/ ./vendor/") < agents_dockerfile.index(
        "RUN pip install --no-cache-dir -r requirements.txt"
    )
    for name in ("Dockerfile.cloudbench-warm", "Dockerfile.cloudbench"):
        dockerfile = (ROOT / name).read_text()
        copied = dockerfile.index("COPY --chown=rose:rose agents/vendor /app/agents/vendor")
        assert copied < dockerfile.index("RUN bash /tmp/rose-cloudbench-install-image-deps.sh"), name

    # Resolve offline exactly as the image installer does: from the checkout root, with the
    # relative find-links interpreted beside the requirements file.
    checkout = tmp_path / "checkout"
    (checkout / "agents/vendor").mkdir(parents=True)
    shutil.copy2(vendor / wheels[0], checkout / "agents/vendor" / wheels[0])
    (checkout / "agents/requirements.txt").write_text("--find-links ./vendor\n" + pins[0] + "\n")
    for cwd, requirements_path in ((checkout, "agents/requirements.txt"), (checkout / "agents", "requirements.txt")):
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--dry-run", "--no-deps", "--no-index",
             "--ignore-installed", "--disable-pip-version-check", "-r", requirements_path],
            cwd=cwd, capture_output=True, text=True, timeout=120,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert "Would install world-model-harness-0.1.0+rose.8e6d55dd" in result.stdout, result.stdout
