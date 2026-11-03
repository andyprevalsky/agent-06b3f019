#!/usr/bin/env python3
"""Run the normal startup browser stanza against local, version-distinct CLI fixtures."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/ensure-playwright-browsers.py"


class BrowserBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.fixture = self.directory / "fixture"
        self.fixture.mkdir()
        (self.fixture / "front-end").mkdir()
        (self.fixture / "front-end/package.json").write_text('{}')
        package = self.directory / "modules/playwright"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text('')
        (package / "sync_api.py").write_text('''
import os
from types import SimpleNamespace
def sync_playwright():
    value=SimpleNamespace(chromium=SimpleNamespace(executable_path=os.environ['PY_PRIMARY']))
    value.start=lambda:value
    value.stop=lambda:None
    return value
''')
        cli = '''
import os,sys,json
from pathlib import Path
runtime='node' if sys.argv[0].endswith('/node') else 'python'
if runtime=='node' and '-e' in sys.argv:
    print(json.dumps({'cli':os.environ['NODE_CLI'],'executable':os.environ['NODE_PRIMARY']}))
    sys.exit(0)
locations=json.loads(os.environ[runtime.upper()+'_LOCATIONS'])
if '--dry-run' in sys.argv:
    for location in locations:print('  Install location: '+location)
    sys.exit(0)
with open(os.environ['INSTALL_LOG'],'a') as f:f.write(runtime+'\\n')
if os.environ.get('FAIL_INSTALL')==runtime:sys.exit(7)
for location in locations:
    p=Path(location);p.mkdir(parents=True,exist_ok=True)
    (p/'INSTALLATION_COMPLETE').touch()
    binary=p/('chrome-headless-shell' if 'headless' in p.name else 'chrome')
    binary.write_text('fixture');binary.chmod(0o700)
if os.environ.get('PRUNE_PEER')==runtime:
    Path(os.environ['NODE_PRIMARY' if runtime=='python' else 'PY_PRIMARY']).unlink(missing_ok=True)
'''
        (package / "__main__.py").write_text(cli)
        bindir = self.directory / "bin"
        bindir.mkdir()
        node = bindir / "node"
        node.write_text('#!' + sys.executable + '\n' + cli)
        node.chmod(0o700)
        self.python_locations = [self.directory / 'python-revision', self.directory / 'python-headless-revision']
        self.node_locations = [self.directory / 'node-different-revision', self.directory / 'node-headless-different-revision']
        self.installs = self.directory / 'installs'
        self.env = {**os.environ, 'PATH':str(bindir)+os.pathsep+os.environ['PATH'],
            'PYTHONPATH':str(package.parent), 'PY_PRIMARY':str(self.python_locations[0]/'chrome'),
            'NODE_PRIMARY':str(self.node_locations[0]/'chrome'), 'NODE_CLI':str(bindir/'own-frontend-cli'),
            'PYTHON_LOCATIONS':json.dumps([str(p) for p in self.python_locations]),
            'NODE_LOCATIONS':json.dumps([str(p) for p in self.node_locations]),
            'INSTALL_LOG':str(self.installs)}
        for location in self.python_locations + self.node_locations:
            location.mkdir();(location/'INSTALLATION_COMPLETE').touch()
            binary=location/('chrome-headless-shell' if 'headless' in location.name else 'chrome')
            binary.write_text('fixture');binary.chmod(0o700)

    def run_startup(self):
        source = Path(os.environ.get('BROWSER_BOOTSTRAP_TEST_SOURCE',str(ROOT/'scripts/run.sh'))).read_text()
        stanza = 'agents/venv/bin/python "$SCRIPT_DIR/ensure-playwright-browsers.py" --root "$PWD" || exit 1'
        if stanza in source:
            self.assertLess(source.index(stanza), source.index('PIDS=()'))
        # Execute the exact production stanza, not a replacement browser decision.
        python = self.fixture/'agents/venv/bin/python'
        python.parent.mkdir(parents=True,exist_ok=True)
        if not python.exists():python.symlink_to(sys.executable)
        script = f'SCRIPT_DIR={json.dumps(str(ROOT/"scripts"))}\n'+(stanza if stanza in source else '')+'\ntouch services-would-start\n'
        return subprocess.run(['bash','-c',script],cwd=self.fixture,env=self.env,
                              capture_output=True,text=True,timeout=15)

    def test_missing_python_headless_binary_installs_exact_python_and_keeps_node(self):
        # Keep the completion marker: it must not conceal a missing executable.
        (self.python_locations[1]/'chrome-headless-shell').unlink()
        result=self.run_startup()
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertTrue(self.installs.exists(),'startup reached services without installing the missing Python browser')
        self.assertEqual(self.installs.read_text().splitlines(),['python'])
        self.assertTrue((self.python_locations[1]/'chrome-headless-shell').is_file())
        self.assertTrue(Path(self.env['NODE_PRIMARY']).is_file())
        self.assertTrue((self.fixture/'services-would-start').exists())
        result=self.run_startup()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(self.installs.read_text().splitlines(),['python'],'warm startup must not acquire installer locks')

    def test_missing_node_revision_uses_frontend_cli_not_python_revision(self):
        (self.node_locations[1]/'INSTALLATION_COMPLETE').unlink()
        result=self.run_startup()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(self.installs.read_text().splitlines(),['node'])

    def test_install_failure_and_peer_pruning_refuse_before_services(self):
        (self.python_locations[1]/'chrome-headless-shell').unlink()
        self.env['FAIL_INSTALL']='python'
        result=self.run_startup()
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.fixture/'services-would-start').exists())
        self.env.pop('FAIL_INSTALL');self.env['PRUNE_PEER']='node'
        # Python repaired first; Node installer then removes Python's primary.
        (self.node_locations[1]/'INSTALLATION_COMPLETE').unlink()
        result=self.run_startup()
        self.assertNotEqual(result.returncode,0,'both consumers must be revalidated after installers')
        self.assertFalse((self.fixture/'services-would-start').exists())


if __name__ == '__main__':
    unittest.main()
