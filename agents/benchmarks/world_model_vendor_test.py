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

def _native_setup_control(tmp_path, *, override=False, cached=False, missing='', corrupt=False,
                          sources='valid', version='0.7.158+rose.bf75987e', python_version='3.12',
                          absent_native=False, mac_hash=False):
    """Run the actual Bash owner; only installer/native execution is synthetic."""
    import os
    checkout = tmp_path / 'checkout'
    (checkout / 'scripts').mkdir(parents=True)
    vendor = checkout / 'agents/vendor/world-model'
    vendor.mkdir(parents=True)
    shutil.copy2(ROOT / 'scripts/setup-world-model.sh', checkout / 'scripts/setup-world-model.sh')
    shutil.copy2(ROOT / 'agents/requirements-world-model.txt', checkout / 'agents/requirements-world-model.txt')
    shutil.copy2(ROOT / 'agents/vendor/world-model' / WHEEL, vendor / WHEEL)
    shutil.copy2(ROOT / 'agents/vendor/world-model/SOURCES.txt', vendor / 'SOURCES.txt')
    if corrupt:
        with (vendor / WHEEL).open('ab') as stream:
            stream.write(b'private integrity control')
    if sources == 'missing':
        (vendor / 'SOURCES.txt').unlink()
    elif sources == 'invalid':
        (vendor / 'SOURCES.txt').write_text(WHEEL + '\n  sha256: not-a-digest\n')
    shim = tmp_path / 'controlled-python'
    shim.write_text('#!' + sys.executable + '\n' + '''import sys,os,types,importlib.metadata,builtins
code=sys.stdin.read()
importlib.metadata.distribution=lambda name:types.SimpleNamespace(version=os.environ['CONTROL_VERSION'])
sys.version_info=tuple(map(int,os.environ['CONTROL_PYTHON_VERSION'].split('.')))
original_import=builtins.__import__
def controlled_import(name,*args,**kwargs):
    if name in ('fastapi','uvicorn'):
        if name==os.environ['CONTROL_MISSING']:raise ModuleNotFoundError(name)
        return types.ModuleType(name)
    return original_import(name,*args,**kwargs)
builtins.__import__=controlled_import
exec(compile(code,'<actual installer validation>','exec'))
''')
    shim.chmod(0o700)
    native = checkout / '.context/experiential-venv'
    if not absent_native:
        (native / 'bin').mkdir(parents=True)
        shutil.copy2(shim, native / 'bin/python')
    signature = hashlib.sha256((checkout / 'agents/requirements-world-model.txt').read_bytes()).hexdigest()
    if cached:
        (native / 'requirements.sha256').write_text(signature + '\n')
    binaries = tmp_path / 'bin'
    binaries.mkdir()
    for command in ('dirname','cut','cat','awk'):
        target = shutil.which(command)
        assert target, command
        (binaries / command).symlink_to(target)
    hash_name = 'shasum' if mac_hash else 'sha256sum'
    target = shutil.which(hash_name)
    assert target, hash_name
    (binaries / hash_name).symlink_to(target)
    calls = tmp_path / 'uv-calls'
    uv = binaries / 'uv'
    uv.write_text('#!' + sys.executable + '\n' + '''import sys,os,pathlib,shutil
with open(os.environ['UV_CALLS'],'a') as f:f.write(' '.join(sys.argv[1:])+'\\n')
if sys.argv[1]=='venv':
    target=pathlib.Path(sys.argv[-1])/'bin';target.mkdir(parents=True)
    shutil.copy2(os.environ['CONTROL_SHIM'],target/'python')
''')
    uv.chmod(0o700)
    env = {'PATH':str(binaries), 'PYTHONDONTWRITEBYTECODE':'1', 'UV_CALLS':str(calls),
           'CONTROL_SHIM':str(shim), 'CONTROL_MISSING':missing, 'CONTROL_VERSION':version,
           'CONTROL_PYTHON_VERSION':python_version}
    if override:
        env['WMH_NATIVE_PYTHON'] = str(shim)
    result = subprocess.run(['/bin/bash',str(checkout / 'scripts/setup-world-model.sh')],
                            env=env,text=True,capture_output=True,timeout=20)
    return result, calls.read_text().splitlines() if calls.exists() else [], native / 'requirements.sha256', signature


def test_native_setup_checks_serving_imports_on_override_and_cached_paths(tmp_path):
    for override, cached in ((True, False), (False, True), (False, False)):
        for missing in ('fastapi','uvicorn'):
            result, calls, marker, _ = _native_setup_control(
                tmp_path / f'{override}-{cached}-{missing}', override=override,cached=cached,missing=missing)
            assert result.returncode != 0, 'installer reported healthy without ' + missing
            assert missing in result.stderr
            assert len(calls) == (0 if override or cached else 2)
            if not cached:
                assert not marker.exists(), 'failed validation created a healthy marker'


def test_native_setup_authenticates_wheel_before_any_environment_mutation(tmp_path):
    for damage in ('wheel','missing','invalid'):
        for override, cached in ((False,False),(True,False),(False,True)):
            result,calls,marker,_ = _native_setup_control(
                tmp_path / f'{damage}-{override}-{cached}',override=override,cached=cached,corrupt=damage=='wheel',
                sources=damage if damage!='wheel' else 'valid',absent_native=not cached)
            assert result.returncode != 0, 'unauthenticated vendor bytes were accepted'
            assert calls == [], 'native installer mutated environment before integrity validation'
            if not cached:
                assert not marker.exists()


def test_native_setup_preserves_valid_override_cache_install_and_version_pins(tmp_path):
    for override,cached,mac_hash in ((True,False,False),(False,True,False),(False,False,False),(False,False,True)):
        result,calls,marker,signature = _native_setup_control(
            tmp_path / f'{override}-{cached}-{mac_hash}',override=override,cached=cached,mac_hash=mac_hash)
        assert result.returncode == 0, result.stderr
        assert len(calls) == (0 if override or cached else 2)
        assert result.stdout.strip().endswith('python')
        if not override:
            assert marker.read_text().strip() == signature
    for mode in ('version','python'):
        result,calls,marker,_ = _native_setup_control(
            tmp_path / mode, override=True,version='0.7.158' if mode=='version' else '0.7.158+rose.bf75987e',
            python_version='3.11' if mode=='python' else '3.12')
        assert result.returncode != 0
        assert ('Unexpected experiential version' if mode=='version' else 'Native world model requires Python') in result.stderr
        assert calls == [] and not marker.exists()
