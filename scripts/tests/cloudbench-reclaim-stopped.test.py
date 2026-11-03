#!/usr/bin/env python3
"""Owning regression for `run-bench reclaim-stopped` (Fly org slots held by stopped task Machines)."""
from pathlib import Path
import http.server, json, os, runpy, subprocess, tempfile, threading, time, unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
H = runpy.run_path(str(ROOT / 'scripts/cloudbench-reclaim-stopped.py'))


def task(i, state='stopped', name=None, metadata=None):
    mid = f'{i:014x}'
    return dict(id=mid, instance_id='inst-' + mid, name=name or f'cloudbench-{i:024x}', state=state,
                config=dict(guest=dict(cpus=4), metadata=metadata or {},
                            mounts=[dict(volume=f'vol_{i:016x}', path='/data')]))


class FakeFly:
    """Machines API fixture: list, exact GET, DELETE Machine/Volume, GET Volume."""

    def __init__(self, rows, delete_status=None):
        self.rows = {r['id']: r for r in rows}
        self.volumes = {m['volume']: 'created' for r in rows for m in r['config']['mounts']}
        self.events, self.lock, self.live, self.peak = [], threading.Lock(), 0, 0
        self.delete_status = delete_status or {}
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, code, value):
                raw = json.dumps(value).encode()
                self.send_response(code)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                with fake.lock:
                    fake.events.append(('GET', self.path))
                    parts = self.path.split('/')
                    if self.path.endswith('/machines'):
                        return self.reply(200, list(fake.rows.values()))
                    if parts[-2] == 'machines':
                        row = fake.rows.get(parts[-1])
                        return self.reply(200, row) if row else self.reply(404, {})
                    state = fake.volumes.get(parts[-1])
                    return self.reply(200, dict(id=parts[-1], state=state)) if state else self.reply(404, {})

            def do_DELETE(self):
                with fake.lock:
                    fake.events.append(('DELETE', self.path))
                    fake.live += 1
                    fake.peak = max(fake.peak, fake.live)
                    queue = fake.delete_status.get(self.path)
                    code = queue.pop(0) if queue else 200
                time.sleep(.03)
                with fake.lock:
                    fake.live -= 1
                    parts = self.path.split('/')
                    if code == 404 and parts[-2] == 'machines':
                        fake.rows.pop(parts[-1], None)  # already gone: no longer listed
                    elif code == 200 and parts[-2] == 'machines':
                        fake.rows[parts[-1]] = dict(fake.rows[parts[-1]], state='destroyed')
                    elif code == 200:
                        fake.volumes[parts[-1]] = 'pending_destroy'
                self.reply(code, {'ok': code == 200})

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def deletes(self):
        return [p for m, p in self.events if m == 'DELETE']


class Reclaim(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        binary = self.root / 'flyctl'
        binary.write_text('#!/bin/sh\nexit 0\n')
        binary.chmod(0o700)

    def cli(self, fake, *args, env=None, attest=True):
        self.addCleanup(fake.server.server_close)
        self.addCleanup(fake.server.shutdown)
        env = dict(os.environ, PATH=str(self.root) + ':' + os.environ['PATH'],
                   FLY_API_HOSTNAME=f'http://127.0.0.1:{fake.server.server_port}',
                   FLY_BENCH_API_TOKEN='fixture-token-with-at-least20chars', **(env or {}))
        env.pop('FLY_APP_NAME', None)
        result = subprocess.run(['bash', str(ROOT / 'scripts/run-bench'), 'reclaim-stopped', '--app', 'fixture',
                                 '--out-dir', str(self.root / 'out'),
                                 *(['--no-other-host-pools'] if attest else []), *args],
                                env=env, capture_output=True, text=True, timeout=60)
        return result, (json.loads(result.stdout) if result.stdout.strip() else None)

    def fleet(self):
        protect_file = self.root / 'protect.json'
        protect_file.write_text(json.dumps([f'{5:014x}']))
        rows = [task(i) for i in range(5)]                                    # 5 reclaimable
        rows += [task(5),                                                      # explicit protect file
                 task(6, state='started'),                                     # live work
                 task(7, name='cloudbench-warm-t10-ord-85a7e2c'),              # warm donor
                 task(8, name='polar-controller-300-ae1d4a66df94'),            # other controller
                 task(9, metadata={'whm_deploy_owner': 'x'}),                  # separately owned
                 task(10, metadata={'rose_controller_role': 'disposable'}),
                 task(11, state='suspended'),
                 task(12)]                                                     # explicit --protect-machine
        return rows, protect_file

    def test_plan_only_never_mutates_and_names_every_kept_reason(self):
        rows, protect_file = self.fleet()
        fake = FakeFly(rows)
        result, summary = self.cli(fake, '--protect-file', str(protect_file), '--protect-machine', f'{12:014x}')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(fake.deletes(), [])
        self.assertEqual((summary['status'], summary['targets'], summary['target_volumes']), ('PLANNED', 5, 5))
        self.assertEqual(summary['kept'], {'explicitly-protected': 2, 'not-stopped': 2,
                                           'not-a-task-machine-name': 2, 'protected-metadata': 2})
        planned = json.loads((self.root / 'out/plan.json').read_text())['target_rows']
        self.assertEqual(sorted(t['machine'] for t in planned), [f'{i:014x}' for i in range(5)])

    def test_execute_destroys_exact_targets_and_their_volumes_only(self):
        rows, protect_file = self.fleet()
        fake = FakeFly(rows)
        result, summary = self.cli(fake, '--execute', '--workers', '3', '--protect-file', str(protect_file),
                                   '--protect-machine', f'{12:014x}')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(summary['results'], {'RECLAIMED': 5})
        self.assertEqual(summary['targets_still_listed'], [])
        expected = {f'/v1/apps/fixture/machines/{i:014x}' for i in range(5)}
        expected |= {f'/v1/apps/fixture/volumes/vol_{i:016x}' for i in range(5)}
        self.assertEqual(set(fake.deletes()), expected)
        self.assertEqual(len(fake.deletes()), len(expected))
        self.assertGreater(fake.peak, 1)
        self.assertLessEqual(fake.peak, 3)
        for i in range(5, 13):
            self.assertNotEqual(fake.rows[f'{i:014x}']['state'], 'destroyed')

    def test_target_that_changed_after_planning_is_refused_without_delete(self):
        fake = FakeFly([task(0), task(1)])
        original = fake.server.RequestHandlerClass.do_GET

        def drift(handler):
            if handler.path.endswith(f'/machines/{0:014x}'):
                with fake.lock:
                    fake.rows[f'{0:014x}'] = dict(fake.rows[f'{0:014x}'], state='started', instance_id='new')
            return original(handler)

        fake.server.RequestHandlerClass.do_GET = drift
        result, summary = self.cli(fake, '--execute')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(summary['results'], {'PENDING': 1, 'RECLAIMED': 1})
        self.assertNotIn(f'/v1/apps/fixture/machines/{0:014x}', fake.deletes())
        terminal = json.loads((self.root / 'out' / f'{0:014x}' / 'terminal.json').read_text())
        self.assertIn('changed', terminal['detail'])

    def test_ambiguous_delete_is_never_retried_and_keeps_volume(self):
        path = f'/v1/apps/fixture/machines/{0:014x}'
        fake = FakeFly([task(0)], delete_status={path: [500]})
        result, summary = self.cli(fake, '--execute')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(fake.deletes(), [path])
        self.assertEqual(summary['results'], {'PENDING': 1})

    def test_rate_limited_delete_is_retried_because_it_was_refused(self):
        path = f'/v1/apps/fixture/machines/{0:014x}'
        fake = FakeFly([task(0)], delete_status={path: [429, 429]})
        result, summary = self.cli(fake, '--execute')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(fake.deletes().count(path), 3)
        self.assertEqual(summary['results'], {'RECLAIMED': 1})

    def test_machine_already_gone_still_releases_its_volume(self):
        path = f'/v1/apps/fixture/machines/{0:014x}'
        fake = FakeFly([task(0)], delete_status={path: [404]})
        result, summary = self.cli(fake, '--execute')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'/v1/apps/fixture/volumes/vol_{0:016x}', fake.deletes())

    def test_slow_exact_read_is_reread_not_abandoned(self):
        calls = []

        class Api:
            def api(self, method, path, body=None, timeout=None):
                calls.append((method, path))
                if len(calls) == 1:
                    time.sleep(1)  # exceeds the (patched) per-call cap
                return {'id': f'{0:014x}', 'state': 'destroyed'} if method == 'GET' else {}

        with patch.dict(H['call'].__globals__, CALL_CAP_SECONDS=.2):
            row = H['read'](Api(), f'/machines/{0:014x}', time.monotonic() + 10)
        self.assertEqual(row['state'], 'destroyed')
        self.assertEqual(len(calls), 2)

    def test_ambiguous_delete_that_took_effect_still_releases_volume(self):
        path = f'/v1/apps/fixture/machines/{0:014x}'
        fake = FakeFly([task(0)], delete_status={path: [500]})
        original = fake.server.RequestHandlerClass.do_DELETE

        def applied_then_failed(handler):
            if handler.path == path:
                with fake.lock:
                    fake.rows[f'{0:014x}'] = dict(fake.rows[f'{0:014x}'], state='destroyed')
            return original(handler)

        fake.server.RequestHandlerClass.do_DELETE = applied_then_failed
        result, summary = self.cli(fake, '--execute')
        self.assertEqual(fake.deletes().count(path), 1)
        self.assertIn(f'/v1/apps/fixture/volumes/vol_{0:016x}', fake.deletes())
        self.assertEqual(summary['results'], {'RECLAIMED': 1})

    def test_running_on_a_target_machine_excludes_it(self):
        rows = [task(0), task(1)]
        fake = FakeFly(rows)
        result, summary = self.cli(fake, env=dict(FLY_MACHINE_ID=f'{0:014x}'))
        self.assertEqual(summary['targets'], 2)  # FLY_APP_NAME differs: not this app's Machine
        self.assertEqual(H['classify'](rows[0], set(), f'{0:014x}'), 'running-this-command')

    def test_existing_output_refuses_before_provider_call(self):
        fake = FakeFly([task(0)])
        (self.root / 'out').mkdir()
        result, _ = self.cli(fake, '--execute')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(fake.events, [])

    def test_local_workspace_pool_members_are_protected(self):
        repo = self.root / 'repo'
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        pools = repo / '.git/cloudbench-pools'
        pools.mkdir()
        (pools / 'ws.ids').write_text(f'{3:014x}\n{4:014x}\n')
        members = H['local_pool_members'](repo)
        self.assertEqual(members, {f'{3:014x}', f'{4:014x}'})
        targets, kept = H['plan']([task(i) for i in range(5)], members, None)
        self.assertEqual(len(targets), 3)
        self.assertEqual(kept, {'explicitly-protected': 2})

    def test_retained_reserved_fixed_and_foreign_pool_machines_are_never_deleted(self):
        base = json.loads((ROOT / 'scripts/cloudbench-fixed-native-worker-baseline.json').read_text())
        fixed = dict(task(20), id=base['machine'], instance_id='inst-fixed', name=base['name'])
        fixed['config']['mounts'] = [dict(volume=base['volume'], path='/data')]
        rows = [task(0),
                task(1, metadata={'cloudbench_archived_reuse': '{"role":"retained-successor"}'}),
                task(2, metadata={'cloudbench_archived_reuse': '{"reservation":"parked"}'}),
                fixed, task(3), task(4), task(5), task(6)]
        foreign = self.root / 'other-host.ids'
        foreign.write_text(f'{3:014x}\n')
        union = self.root / 'union.json'
        union.write_text(json.dumps(dict(schema='cloudbench-protected-resource-union-v1', machines=[],
                                         names=[f'cloudbench-{4:024x}'], volumes=[f'vol_{5:016x}'])))
        fake = FakeFly(rows)
        result, summary = self.cli(fake, '--execute', '--other-host-pools-file', str(foreign),
                                   '--protect-file', str(union), attest=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(summary['results'], {'RECLAIMED': 2})
        self.assertEqual(sorted(p for p in fake.deletes() if '/machines/' in p),
                         [f'/v1/apps/fixture/machines/{i:014x}' for i in (0, 6)])
        self.assertEqual(summary['kept'], {'protected-metadata': 2, 'explicitly-protected': 4})

    def test_undeclared_other_host_pools_refuse_before_provider_call(self):
        fake = FakeFly([task(0)])
        result, summary = self.cli(fake, '--execute', attest=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('other hosts', result.stderr)
        self.assertEqual(fake.events, [])

    def test_pool_index_read_failure_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'refusing reclaim'):
            H['local_pool_members'](self.root / 'not-a-repo')
        repo = self.root / 'repo'
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        (repo / '.git/cloudbench-pools').mkdir()
        (repo / '.git/cloudbench-pools/ws.ids').mkdir()  # unreadable index entry
        with self.assertRaisesRegex(ValueError, 'refusing reclaim'):
            H['local_pool_members'](repo)
        with patch.dict(H['fixed_native_worker'].__globals__, __file__=str(self.root / 'x/y.py')):
            with self.assertRaisesRegex(ValueError, 'refusing reclaim'):
                H['fixed_native_worker']()

    def test_local_pool_claims_are_protected(self):
        repo = self.root / 'repo'
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        claims = repo / '.git/cloudbench-pool-claims'
        (claims / '.locks').mkdir(parents=True)
        (claims / f'{2:014x}').write_text('owner=x\n')
        self.assertEqual(H['local_pool_members'](repo), {f'{2:014x}'})

    def test_imported_worker_pool_ledger_members_are_protected(self):
        repo = self.root / 'repo'
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        pools = repo / '.git/cloudbench-worker-pools'
        pools.mkdir()
        (pools / 'workers').write_text(f'{7:014x}\n{8:014x}\n')
        (pools / 'workers.deps').write_text('{"role":"worker"}\n')
        (pools / 'workers.lock').write_text('')
        members = H['local_pool_members'](repo)
        self.assertEqual(members, {f'{7:014x}', f'{8:014x}'})
        targets, kept = H['plan']([task(i) for i in range(9)], members, None)
        self.assertEqual(len(targets), 7)
        self.assertEqual(kept, {'explicitly-protected': 2})
        (pools / 'broken').write_text('not-a-machine\n')
        with self.assertRaisesRegex(ValueError, 'refusing reclaim'):
            H['local_pool_members'](repo)
        (pools / 'broken').unlink()
        (pools / 'unreadable').mkdir()
        with self.assertRaisesRegex(ValueError, 'refusing reclaim'):
            H['local_pool_members'](repo)

    def test_invalid_inventory_refuses(self):
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            H['inventory']([task(0), task(0)])
        with self.assertRaisesRegex(ValueError, 'unknown'):
            H['inventory']([task(0, state='mystery')])


if __name__ == '__main__':
    unittest.main()
