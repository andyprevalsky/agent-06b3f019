#!/usr/bin/env python3
"""Offline public CLI, original argv and fresh capacity/binding contracts."""
import argparse
import importlib.util
import io
import http.server
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('operator_cli', Path(os.environ.get('PORTABLE_OPERATOR_SOURCE', ROOT/'scripts/run-original600-controller.py')))
CLI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLI)
RUNNER = runpy.run_path(str(ROOT/'scripts/cloudbench-original600-runner.py'))


def private(path, value):
    path.write_text(json.dumps(value) if not isinstance(value, str) else value)
    path.chmod(0o600)
    return path


class Portable(unittest.TestCase):
    def test_drip_response_is_bounded_without_orphan_reader(self):
        class Drip(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', '100000')
                self.end_headers()
                try:
                    for _ in range(30):
                        self.wfile.write(b' ')
                        self.wfile.flush()
                        time.sleep(.03)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *unused):
                pass

        with tempfile.TemporaryDirectory() as name:
            server = http.server.HTTPServer(('127.0.0.1', 0), Drip)
            thread = threading.Thread(target=server.handle_request)
            thread.start()
            url = 'http://127.0.0.1:' + str(server.server_port)
            real_open = CLI.urllib.request.urlopen

            class API:
                def __init__(self, *unused):
                    pass
                def api(self, *unused, **kwargs):
                    with real_open(url, timeout=20) as response:
                        return json.load(response)

            settings = {'data': {'organization': {'slug': 'personal', 'settings': {'machines_per_org_limit': 1000}, 'billingStatus': 'fixture'}}}
            apps = subprocess.CompletedProcess([], 0, json.dumps([{'Name': 'navi-whisper-lux-bench', 'Organization': {'Slug': 'personal'}}]), '')
            start = time.monotonic()
            try:
                with patch.object(CLI.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(settings).encode())), \
                     patch.object(CLI.subprocess, 'run', return_value=apps):
                    with self.assertRaises(RUNNER['Deadline']):
                        with RUNNER['bounded'](.15):
                            CLI.capacity(API, 'fixture', 'personal', Path(name), 1)
                self.assertLess(time.monotonic()-start, .6)
                self.assertFalse((Path(name)/'capacity-proof.private.json').exists())
            finally:
                thread.join(timeout=2)
                server.server_close()
            self.assertFalse(thread.is_alive())

    def test_public_check_is_path_independent_and_no_provider_or_state_creation(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)/'checkout'
            (root/'scripts').mkdir(parents=True)
            for member in CLI.PINS:
                (root/'scripts'/member).write_bytes((ROOT/'scripts'/member).read_bytes())
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            subprocess.run(['git', '-C', str(root), 'add', 'scripts'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test',
                            '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], check=True)
            ref = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
            inputs = Path(name)/'inputs'
            inputs.mkdir(mode=0o700)
            state = inputs/'state'
            state.mkdir(mode=0o700)
            fakebin = inputs/'bin'
            fakebin.mkdir()
            marker = inputs/'provider-called'
            fly = fakebin/'flyctl'
            fly.write_text('#!/bin/sh\nif [ "$1" = version ]; then echo "flyctl v0.4.115 linux/amd64"; exit 0; fi\n: > "$PROVIDER_MARKER"\nexit 99\n')
            fly.chmod(0o700)
            args = [sys.executable, str(root/'scripts/run-original600-controller.py'), '--source-ref', ref,
                    '--state-dir', str(state)]
            tasks = json.loads((ROOT/'scripts/tests/fixtures/original600-tasks.json').read_text())
            facts = dict(app='navi-whisper-lux-bench', image_ref='registry.fly.io/fixture@sha256:'+'a'*64,
                         protected_machines=['m1', 'm2', 'm3', 'm4'], protected_volumes=['v1'])
            for flag, data in [('facts', facts), ('agents-env', 'FLY_API_TOKEN=fixture\n'), ('backend-env', 'COMPLETE=fixture\n'),
                               ('tasks', tasks), ('snapshot-inventory', {}), ('warm-deps', 'fixture')]:
                args += ['--'+flag, str(private(inputs/flag, data))]
            env = dict(os.environ, PATH=str(fakebin)+':'+os.environ['PATH'], PROVIDER_MARKER=str(marker))
            result = subprocess.run(args, cwd='/', env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['status'], 'CHECKED_NOT_LAUNCHED')
            self.assertFalse(marker.exists())
            self.assertEqual(list(state.iterdir()), [])
            # Same public command must refuse changed committed source before a provider call.
            with (root/'scripts/cloudbench-shared-relay.py').open('a') as f:
                f.write('\n# altered fixture\n')
            refused = subprocess.run(args, cwd='/', env=env, capture_output=True, timeout=10)
            self.assertNotEqual(refused.returncode, 0)
            self.assertFalse(marker.exists())

    def test_fresh_all_app_capacity_and_original_binding(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            facts = dict(app='navi-whisper-lux-bench', image_ref='registry.fly.io/fixture@sha256:'+'a'*64,
                         protected_machines=['m1', 'm2', 'm3', 'm4'], protected_volumes=['v1'])
            args = argparse.Namespace(source_ref='a'*40, facts=private(directory/'facts', facts),
                  agents_env=private(directory/'agents.env', 'FLY_API_TOKEN=fixture\n'),
                  backend_env=private(directory/'backend.env', 'COMPLETE=fixture\n'),
                  tasks=private(directory/'tasks', json.loads((ROOT/'scripts/tests/fixtures/original600-tasks.json').read_text())),
                  snapshot_inventory=private(directory/'snapshot', {}), warm_deps=private(directory/'warm', 'fixture'))
            settings = {'data': {'organization': {'slug': 'personal', 'settings': {'machines_per_org_limit': 1000}, 'billingStatus': 'fixture'}}}
            calls = []

            class API:
                def __init__(self, app, token):
                    self.app = app
                def api(self, method, path, timeout):
                    calls.append((self.app, method, path))
                    return [{'id': self.app+'-machine'}]

            response = subprocess.CompletedProcess([], 0, json.dumps([{'Name': 'navi-whisper-lux-bench', 'Organization': {'Slug': 'personal'}}, {'Name': 'new-app', 'Organization': {'Slug': 'personal'}}]), '')
            with patch.object(CLI.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(settings).encode())), \
                 patch.object(CLI.subprocess, 'run', return_value=response):
                cap = CLI.capacity(API, 'fixture', 'personal', directory, 1)
            self.assertCountEqual(calls, [('navi-whisper-lux-bench', 'GET', '/machines'), ('new-app', 'GET', '/machines')])
            foreign = subprocess.CompletedProcess([], 0, json.dumps([{'Name': 'unrelated', 'Organization': {'Slug': 'personal'}}]), '')
            with patch.object(CLI.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(settings).encode())), \
                 patch.object(CLI.subprocess, 'run', return_value=foreign):
                with self.assertRaisesRegex(ValueError, 'does not include'):
                    CLI.capacity(API, 'fixture', 'personal', directory, 1)
            self.assertEqual(cap['available_slots_conservative'], 997)
            config = CLI.prepare(args, ROOT, {n: 'b'*64 for n in CLI.PINS}, RUNNER, directory, cap)
            value = json.loads(config.read_text())
            argv = RUNNER['campaign_argv'](json.loads(args.tasks.read_text()), value['started_at_epoch'])
            self.assertEqual(argv[argv.index('--concurrency')+1], '600')
            self.assertEqual(argv[argv.index('--timeout')+1], '1200')
            self.assertEqual(argv[argv.index('--e2e-timeout')+1], '5400')
            self.assertEqual(argv[argv.index('--ref')+1], '570830dbf17635e13d16a6f03b4d705f6b6443b1')
            cap['ended_epoch'] = time.time()-271
            with self.assertRaisesRegex(ValueError, 'expired'):
                CLI.prepare(args, ROOT, {}, RUNNER, directory, cap)


if __name__ == '__main__':
    unittest.main()
