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

import pytest

ROOT = Path(__file__).resolve().parents[2]
VERSION = "0.7.158+rose.bf75987e.elapsed1"
WHEEL = f"experiential-{VERSION}-py3-none-any.whl"
PIN = f"experiential=={VERSION}"


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
    assert f"dist.version=='{VERSION}'" in setup and "vcs_info" not in setup


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
        assert f"Would install experiential-{VERSION}" in result.stdout, result.stdout

def _native_setup_control(tmp_path, *, override=False, cached=False, missing='', corrupt=False,
                          sources='valid', version=VERSION, python_version='3.12',
                          absent_native=False, mac_hash=False, caller_cwd=None, find_links_base=None,
                          uv_home_local=False):
    """Run the actual Bash owner; only installer/native execution is synthetic."""
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
if sys.argv[1:3]==['pip','install'] and os.environ.get('CONTROL_FIND_LINKS_BASE'):
    requirement=pathlib.Path(sys.argv[sys.argv.index('-r')+1])
    assert requirement.is_absolute()
    assert pathlib.Path(sys.argv[sys.argv.index('--python')+1]).is_absolute()
    links=next(line.split(maxsplit=1)[1] for line in requirement.read_text().splitlines() if line.startswith('--find-links '))
    base=pathlib.Path.cwd() if os.environ['CONTROL_FIND_LINKS_BASE']=='cwd' else requirement.parent
    if not (base/links).is_dir():
        print('CONTROL: vendored find-links directory missing at '+str(base/links),file=sys.stderr)
        sys.exit(31)
if sys.argv[1]=='venv':
    target=pathlib.Path(sys.argv[-1])/'bin';target.mkdir(parents=True)
    shutil.copy2(os.environ['CONTROL_SHIM'],target/'python')
''')
    uv.chmod(0o700)
    home = tmp_path / 'home'
    if uv_home_local:
        # A non-interactive shell lacks the user's ~/.local/bin on PATH.
        (home / '.local/bin').mkdir(parents=True)
        uv.rename(home / '.local/bin/uv')
    env = {'PATH':str(binaries), 'HOME':str(home), 'PYTHONDONTWRITEBYTECODE':'1', 'UV_CALLS':str(calls),
           'CONTROL_SHIM':str(shim), 'CONTROL_MISSING':missing, 'CONTROL_VERSION':version,
           'CONTROL_PYTHON_VERSION':python_version}
    if find_links_base:
        env['CONTROL_FIND_LINKS_BASE'] = find_links_base
    execution_cwd = checkout if caller_cwd == 'root' else tmp_path / 'arbitrary-caller' if caller_cwd == 'arbitrary' else None
    if execution_cwd is not None:
        execution_cwd.mkdir(exist_ok=True)
    if override:
        env['WMH_NATIVE_PYTHON'] = str(shim)
    result = subprocess.run(['/bin/bash',str(checkout / 'scripts/setup-world-model.sh')],
                            env=env,cwd=execution_cwd,text=True,capture_output=True,timeout=20)
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
            tmp_path / mode, override=True,version='0.7.158+rose.bf75987e' if mode=='version' else VERSION,
            python_version='3.11' if mode=='python' else '3.12')
        assert result.returncode != 0
        assert ('Unexpected experiential version' if mode=='version' else 'Native world model requires Python') in result.stderr
        assert calls == [] and not marker.exists()


@pytest.mark.parametrize("caller", ["root", "arbitrary"])
@pytest.mark.parametrize("base", ["cwd", "requirements"])
def test_native_setup_resolves_vendored_links_under_both_uv_path_contracts(tmp_path, caller, base):
    """The actual installer owns cwd; old/current uv semantics resolve the same wheel."""
    result, calls, marker, signature = _native_setup_control(
        tmp_path, caller_cwd=caller, find_links_base=base)
    assert result.returncode == 0, result.stdout + result.stderr
    assert len(calls) == 2 and calls[0].startswith("pip install ") and calls[1].startswith("pip check ")
    assert marker.read_text().strip() == signature


def test_native_setup_path_independence_preserves_override_and_cached_no_install(tmp_path):
    for caller in ("root", "arbitrary"):
        for override, cached in ((True, False), (False, True)):
            result, calls, marker, signature = _native_setup_control(
                tmp_path / f"{caller}-{override}-{cached}", override=override, cached=cached,
                caller_cwd=caller, find_links_base="cwd")
            assert result.returncode == 0, result.stdout + result.stderr
            assert calls == []
            if cached:
                assert marker.read_text().strip() == signature
            else:
                assert not marker.exists()


def test_native_setup_finds_user_local_uv_when_it_is_not_on_path(tmp_path):
    """A restored devbox's tool shells had uv only in ~/.local/bin (`uv: command not found`)."""
    result, calls, marker, signature = _native_setup_control(tmp_path, absent_native=True, uv_home_local=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert [c.split()[0] for c in calls] == ["venv", "pip", "pip"]
    assert marker.read_text().strip() == signature


def test_vendored_wheel_contains_every_reviewed_patch():
    """The wheel is the base pin plus patches/*.patch (scripts/build-world-model-wheel.sh), nothing hidden."""
    import zipfile

    patches = sorted((ROOT / "agents/vendor/world-model/patches").glob("*.patch"))
    assert patches, "the patched wheel must keep its reviewed patch source"
    sources = (ROOT / "agents/vendor/world-model/SOURCES.txt").read_text()
    build = (ROOT / "scripts/build-world-model-wheel.sh").read_text()
    assert f'version="{VERSION}"' in build
    with zipfile.ZipFile(ROOT / "agents/vendor/world-model" / WHEEL) as wheel:
        for patch in patches:
            assert patch.name in sources
            current = None
            for line in patch.read_text().splitlines():
                if line.startswith("+++ "):
                    current = wheel.read(line[4:].split("/", 1)[1]).decode()
                elif line.startswith("+") and line[1:].strip():
                    assert line[1:] in current, f"{patch.name}: missing patched line {line[1:]!r}"
        assert f"Version: {VERSION}" in wheel.read(f"experiential-{VERSION}.dist-info/METADATA").decode()
