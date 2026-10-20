#!/usr/bin/env python3
"""Owning regression for sharded benchmark controllers: planning, global barrier, merge."""
from pathlib import Path
import json, os, runpy, signal, tempfile, unittest

ROOT = Path(__file__).resolve().parents[2]
C = runpy.run_path(str(ROOT / 'scripts/cloudbench-shard-coordinator.py'))
R = runpy.run_path(str(ROOT / 'scripts/cloudbench-original600-runner.py'))
TASKS = [f'task-{i:03d}' for i in range(200)]


class FakeRunner:
    """Popen-like runner whose shard status is scripted per world tick."""

    def __init__(self, out, script):
        self.out, self.script, self.pid, self.code, self.signals = Path(out), script, 1000 + len(script), None, []

    def tick(self, n):
        for step, (status, infra, exit_code) in sorted(self.script.items()):
            if step <= n:
                current = (status, infra, exit_code)
        if 'current' not in locals():
            return
        status, infra, exit_code = current
        row = dict(schema='original600-shard-status-v1', state='LIVE', observed_at=n,
                   barrier=None if status is None else dict(status=status), infra=dict(infra_true=infra))
        (self.out / 'shard-status.json').write_text(json.dumps(row))
        if exit_code is not None and self.code is None:
            self.code = exit_code
        if self.signals and self.code is None:
            self.code = 143  # runner joined its own supervisor after TERM

    def poll(self):
        return self.code

    def wait(self):
        return self.code

    def send_signal(self, number):
        self.signals.append(number)


class World:
    def __init__(self, root, scripts, max_ticks=200):
        self.root, self.n, self.max = Path(root), 0, max_ticks
        self.shards, self.runners = [], {}
        for i, script in enumerate(scripts):
            out = self.root / f'shard-{i:02d}'
            out.mkdir()
            self.shards.append(dict(index=i, out=out))
            self.runners[i] = FakeRunner(out, script)
        self.release_seen_at = {}

    def spawn(self, shard):
        return self.runners[shard['index']]

    def sleep(self, seconds):
        self.n += 1
        if self.n > self.max:
            raise AssertionError('coordinator did not finish')
        for i, shard in enumerate(self.shards):
            if (shard['out'] / 'global-release.json').exists() and i not in self.release_seen_at:
                self.release_seen_at[i] = self.n
            self.runners[i].tick(self.n)

    def run(self, **kwargs):
        for i in self.runners:
            self.runners[i].tick(0)
        return C['coordinate'](self.shards, self.spawn, self.root / 'coordination.json', sleep=self.sleep,
                               clock=lambda: float(self.n), poll_seconds=0, **kwargs)


class Planning(unittest.TestCase):
    def test_original_600_on_performance_8x_uses_twenty_controllers_of_thirty_copies(self):
        plan = C['plan_shards'](TASKS, 3)
        self.assertEqual((plan['copies_per_controller_bound'], plan['controllers'], plan['copies']), (32, 20, 600))
        self.assertEqual({len(s['tasks']) for s in plan['shards']}, {10})
        self.assertEqual(sorted(t for s in plan['shards'] for t in s['tasks']), TASKS)
        for shard in plan['shards']:  # each shard is an ordered subset of the manifest
            self.assertEqual(shard['tasks'], sorted(shard['tasks'], key=TASKS.index))
        indexes = sorted(i for s in plan['shards'] for i in s['task_indexes'])
        self.assertEqual(indexes, list(range(200)))
        for shard in plan['shards']:
            self.assertEqual([TASKS[i] for i in shard['task_indexes']], shard['tasks'])

    def test_small_campaign_keeps_one_controller(self):
        plan = C['plan_shards'](TASKS[:10], 3)
        self.assertEqual(plan['controllers'], 1)
        self.assertEqual(plan['shards'][0]['tasks'], TASKS[:10])

    def test_uneven_split_is_balanced_within_one_task(self):
        plan = C['plan_shards'](TASKS[:34], 3)
        sizes = [len(s['tasks']) for s in plan['shards']]
        self.assertEqual(plan['controllers'], 4)
        self.assertLessEqual(max(sizes) - min(sizes), 1)

    def test_explicit_controllers_and_override(self):
        self.assertEqual(C['plan_shards'](TASKS, 3, controllers=25)['controllers'], 25)
        with self.assertRaisesRegex(ValueError, 'exceed'):
            C['plan_shards'](TASKS, 3, controllers=4)
        plan = C['plan_shards'](TASKS, 3, tasks_per_controller=50)
        self.assertEqual(plan['controllers'], 4)
        with self.assertRaisesRegex(ValueError, 'conflicts'):
            C['plan_shards'](TASKS, 3, controllers=5, tasks_per_controller=50)

    def test_capacity_and_runtime_budget(self):
        self.assertEqual(C['capacity_demand'](600, 20), 660)
        env = C['shard_runtime_env'](machine_limit=1000, other_app_objects=37, extra_destroying=1,
                                     planned_shared_cpus=2400, baseline_shared_cpus=8, controllers=20)
        self.assertEqual(env['CLOUDBENCH_APP_MACHINE_CEILING'], '962')
        self.assertEqual(env['CLOUDBENCH_SHARED_CPU_GOVERNOR'], '2428')
        self.assertEqual(env['CLOUDBENCH_SNAPSHOT_POLL_SECONDS'], '60')
        # 20 shards share one Hub write budget instead of each offering it.
        self.assertAlmostEqual(20 * float(env['BENCHMARK_HUB_LIVE_UPLOADS_PER_SECOND']),
                               C['HUB_GLOBAL_LIVE_UPLOADS_PER_SECOND'])
        self.assertLessEqual(20 * int(env['BENCHMARK_HUB_TERMINAL_CONCURRENCY']), C['HUB_GLOBAL_TERMINAL_IN_FLIGHT'])
        self.assertEqual(env['BENCHMARK_HUB_TERMINAL_PUBLICATION_SECONDS'], '1200')
        # 20 shard hosts share the production namespace's Temporal visibility budget.
        self.assertAlmostEqual(20 * float(env['CLOUDBENCH_TEMPORAL_VISIBILITY_CALLS_PER_SECOND']),
                               C['TEMPORAL_GLOBAL_VISIBILITY_CALLS_PER_SECOND'])
        self.assertEqual(C['shard_runtime_env'](machine_limit=1000, other_app_objects=37, extra_destroying=1,
                         planned_shared_cpus=10, baseline_shared_cpus=0, controllers=1)['CLOUDBENCH_SNAPSHOT_POLL_SECONDS'], '15')


class Coordination(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_release_only_after_every_shard_is_ready(self):
        scripts = [{0: ('waiting', 0, None), 2: ('ready', 0, None), 20: ('released', 0, 0)},
                   {0: ('waiting', 0, None), 5: ('ready', 0, None), 20: ('released', 0, 0)},
                   {0: (None, 0, None), 9: ('ready', 0, None), 20: ('released', 0, 0)}]
        world = World(self.tmp.name, scripts)
        record = world.run(scheduled_total=9)
        self.assertEqual(set(world.release_seen_at), {0, 1, 2})
        self.assertEqual(min(world.release_seen_at.values()), 10)  # first poll after the last shard is ready
        self.assertIsNone(record['aborted_at'])
        self.assertEqual(record['exit_codes'], {'0': 0, '1': 0, '2': 0})
        ids = {json.loads((s['out'] / 'global-release.json').read_text())['release_id'] for s in world.shards}
        self.assertEqual(ids, {record['release_id']})

    def test_one_shard_failing_before_release_aborts_all(self):
        scripts = [{0: ('ready', 0, None), 12: ('aborted', 0, 1)},
                   {0: ('waiting', 0, None), 3: ('failed', 0, None), 6: ('failed', 0, 1)},
                   {0: ('waiting', 0, None), 12: ('aborted', 0, 1)}]
        world = World(self.tmp.name, scripts)
        record = world.run(scheduled_total=9)
        self.assertEqual(world.release_seen_at, {})
        self.assertIn('[1]', record['abort_reason'])
        for shard in world.shards:
            self.assertTrue((shard['out'] / 'global-abort.json').exists())

    def test_runner_exit_before_release_aborts(self):
        scripts = [{0: ('ready', 0, None), 10: ('aborted', 0, 1)}, {0: (None, 0, None), 2: (None, 0, 1)}]
        world = World(self.tmp.name, scripts)
        record = world.run(scheduled_total=6)
        self.assertEqual(world.release_seen_at, {})
        self.assertIsNotNone(record['aborted_at'])

    def test_infra_threshold_terminates_every_runner_when_enabled(self):
        scripts = [{0: ('released', 10, None)}, {0: ('released', 19, None), 4: ('released', 20, None)}]
        world = World(self.tmp.name, scripts)
        record = world.run(scheduled_total=600)
        self.assertIn('30/600', record['terminate_reason'])
        self.assertTrue(all(r.signals == [signal.SIGTERM] for r in world.runners.values()))

    def test_infra_threshold_is_report_only_when_disabled(self):
        scripts = [{0: ('released', 10, None), 6: ('released', 10, 0)},
                   {0: ('released', 25, None), 6: ('released', 25, 0)}]
        world = World(self.tmp.name, scripts)
        record = world.run(scheduled_total=600, infra_early_stop='disabled')
        self.assertIsNone(record['terminated_at'])
        self.assertEqual(record['infra_true'], 35)
        self.assertTrue(all(r.signals == [] for r in world.runners.values()))

    def test_operator_signal_aborts_and_terminates_then_joins_all(self):
        scripts = [{0: ('waiting', 0, None)}, {0: ('waiting', 0, None)}]
        world = World(self.tmp.name, scripts)
        original = world.sleep

        def sleep_then_signal(seconds):
            if world.n == 3:
                os.kill(os.getpid(), signal.SIGTERM)
            original(seconds)

        world.sleep = sleep_then_signal
        record = world.run(scheduled_total=6)
        self.assertEqual(record['abort_reason'], 'operator SIGTERM')
        self.assertTrue(all(r.signals == [signal.SIGTERM] for r in world.runners.values()))
        self.assertEqual(set(record['exit_codes'].values()), {143})
        self.assertIs(signal.getsignal(signal.SIGTERM), signal.SIG_DFL)

    def test_abort_before_a_runner_created_its_directory_is_delivered_later(self):
        scripts = [{0: ('failed', 0, None), 6: ('failed', 0, 1)}, {0: ('waiting', 0, None), 8: ('aborted', 0, 1)}]
        world = World(self.tmp.name, scripts)
        late = world.shards[1]['out']
        late.rmdir()
        original = world.sleep

        def create_late(seconds):
            if world.n == 4:
                late.mkdir()
            original(seconds)

        world.sleep = create_late
        world.runners[1].tick = lambda n, tick=world.runners[1].tick: tick(n) if late.is_dir() else None
        record = world.run(scheduled_total=6)
        self.assertIsNotNone(record['aborted_at'])
        self.assertTrue((late / 'global-abort.json').exists())

    def retry_world(self, terminal, retry_outcome='ready'):
        """Shard 1's first runner ends before release with `terminal`; respawns behave per retry_outcome."""
        scripts = [{0: ('ready', 0, None), 30: ('released', 0, 0)}, {0: (None, 0, None), 3: (None, 0, 1)}]
        world = World(self.tmp.name, scripts)
        first = world.runners[1]
        original_tick = first.tick

        def tick(n):
            original_tick(n)
            if first.code is not None and not (first.out / 'terminal.json').exists():
                (first.out / 'terminal.json').write_text(json.dumps(dict(status=terminal)))
        first.tick = tick
        respawned = []

        def respawn(shard):
            out = Path(self.tmp.name) / f"shard-{shard['index']:02d}-attempt-{len(respawned) + 2}"
            out.mkdir()
            if retry_outcome == 'ready':
                runner = FakeRunner(out, {0: ('waiting', 0, None), 2: ('ready', 0, None), 30: ('released', 0, 0)})
            else:
                runner = FakeRunner(out, {0: (None, 0, None), 2: (None, 0, 1)})
                base = runner.tick
                def failing(n, runner=runner, base=base):
                    base(n)
                    if runner.code is not None and not (runner.out / 'terminal.json').exists():
                        (runner.out / 'terminal.json').write_text(json.dumps(dict(status=terminal)))
                runner.tick = failing
            runner.pid = 5000 + len(respawned)
            world.runners[shard['index']] = runner
            respawned.append(out)
            return dict(out=out), runner
        return world, respawn, respawned

    def test_shard_that_failed_before_dispatch_is_retried_and_the_run_still_releases(self):
        world, respawn, respawned = self.retry_world('FAILED_BEFORE_PROVIDER_DISPATCH')
        record = world.run(scheduled_total=6, respawn=respawn)
        self.assertEqual(len(respawned), 1)
        self.assertIsNone(record['aborted_at'])
        self.assertIsNotNone(record['released_at'])
        self.assertTrue((respawned[0] / 'global-release.json').exists())
        self.assertEqual([r['previous'] for r in record['retries']], ['FAILED_BEFORE_PROVIDER_DISPATCH'])

    def test_retries_are_bounded_then_the_run_aborts(self):
        world, respawn, respawned = self.retry_world('FAILED_STARTUP_WORKSPACE_RELEASED', retry_outcome='fail')
        record = world.run(scheduled_total=6, respawn=respawn)
        self.assertEqual(len(respawned), C['MAX_SHARD_ATTEMPTS'] - 1)
        self.assertIsNotNone(record['aborted_at'])
        self.assertIsNone(record['released_at'])

    def test_a_shard_that_may_hold_resources_is_never_retried(self):
        world, respawn, respawned = self.retry_world('CONTROLLER_RELEASE_VERIFIED')
        record = world.run(scheduled_total=6, respawn=respawn)
        self.assertEqual(respawned, [])
        self.assertIsNotNone(record['aborted_at'])

    def test_a_respawn_that_raises_a_base_exception_aborts_instead_of_crashing(self):
        # The second live 600-copy launch lost its coordinator when a retry's capacity read
        # raised the runner's Deadline (a BaseException), orphaning every runner.
        class Deadline(BaseException):
            pass
        world, _, respawned = self.retry_world('FAILED_BEFORE_PROVIDER_DISPATCH')
        def respawn(shard):
            raise Deadline('external controller I/O deadline')
        world.runners[0].script = {0: ('ready', 0, None), 6: ('aborted', 0, 1)}
        record = world.run(scheduled_total=6, respawn=respawn)
        self.assertIsNotNone(record['aborted_at'])
        self.assertEqual([r['error'] for r in record['retries']], ['Deadline'])
        self.assertTrue((world.shards[0]['out'] / 'global-abort.json').exists())

    def test_internal_failure_after_runners_started_aborts_terminates_and_joins_every_runner(self):
        # A later spawn, journal save or decision write raising must not orphan already-started
        # runners at the strict barrier with their disposable controllers allocated.
        class SpawnFailed(Exception):
            pass

        def failing_spawn(world):
            def spawn(shard):
                if shard['index'] == 2:
                    raise SpawnFailed('provider refused the third controller')
                return world.spawn(shard)
            return spawn

        def failing_save(original):
            calls = []
            def save(path, value):
                calls.append(path)
                if len(calls) == 1:  # the journal write right after every runner started
                    raise OSError('journal disk full')
                return original(path, value)
            return save

        def failing_write_once(original):
            def write_once(path, value):
                if path.name == 'global-abort.json' and value['reason'].startswith('shard'):
                    raise OSError('decision delivery failed')
                return original(path, value)
            return write_once

        g = C['coordinate'].__globals__
        cases = [('spawn', SpawnFailed, lambda w: dict(), failing_spawn, {0, 1}),
                 ('save', OSError, lambda w: dict(save=failing_save(g['save'])), None, {0, 1, 2}),
                 ('write_once', OSError, lambda w: dict(write_once=failing_write_once(g['write_once'])), None,
                  {0, 1, 2})]
        for name, error, patches, spawn_factory, started in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                scripts = [{0: ('waiting', 0, None)}, {0: ('waiting', 0, None)},
                           {0: ('failed', 0, None)} if name == 'write_once' else {0: ('waiting', 0, None)}]
                world = World(root, scripts)
                for runner in world.runners.values():
                    runner.wait = lambda r=runner: r.code if r.code is not None else (
                        143 if r.signals else self.fail('join before TERM'))
                    runner.tick(0)
                spawn = spawn_factory(world) if spawn_factory else world.spawn
                original = dict(g)
                try:
                    g.update(patches(world))
                    with self.assertRaises(error):
                        C['coordinate'](world.shards, spawn, Path(root) / 'coordination.json', sleep=world.sleep,
                                        clock=lambda: float(world.n), poll_seconds=0, scheduled_total=9)
                finally:
                    g.update(save=original['save'], write_once=original['write_once'])
                for i in started:
                    self.assertEqual(world.runners[i].signals, [signal.SIGTERM])
                    self.assertTrue((world.shards[i]['out'] / 'global-abort.json').exists())
                    self.assertFalse((world.shards[i]['out'] / 'global-release.json').exists())
                for i in set(world.runners) - started:
                    self.assertEqual(world.runners[i].signals, [])
                journal = json.loads((Path(root) / 'coordination.json').read_text())
                self.assertIn('coordinator failed', journal['terminate_reason'])
                self.assertEqual(set(journal['exit_codes']), {str(i) for i in started})
                self.assertIs(signal.getsignal(signal.SIGTERM), signal.SIG_DFL)

    def test_runner_spawns_are_staggered(self):
        scripts = [{0: ('ready', 0, None), 5: ('released', 0, 0)} for _ in range(3)]
        world = World(self.tmp.name, scripts)
        sleeps = []
        original = world.sleep
        world.sleep = lambda seconds: (sleeps.append(seconds), original(seconds))
        world.run(scheduled_total=9, stagger_seconds=2.0)
        self.assertEqual(sleeps[:2], [2.0, 2.0])

    def test_decision_files_are_never_replaced(self):
        path = Path(self.tmp.name) / 'global-release.json'
        C['write_once'](path, dict(release_id='first'))
        C['write_once'](path, dict(release_id='second'))
        self.assertEqual(json.loads(path.read_text())['release_id'], 'first')
        self.assertEqual(sorted(p.name for p in Path(self.tmp.name).iterdir()), ['global-release.json'])


class Merge(unittest.TestCase):
    def test_combines_shards_without_inventing_missing_jobs(self):
        a = dict(jobs=[dict(job_id='r001-j0000', status='passed', task_status='PASSED', terminal_task=True,
                            lifecycle_verified=True, resources_released=True, infra_failure=False)])
        b = dict(jobs=[dict(job_id='r001-j0001', status='failed', task_status='INFRA_ERROR', terminal_task=False,
                            lifecycle_verified=False, resources_released=True, infra_failure=True)])
        merged = C['merge']([a, b], scheduled_total=3)
        self.assertEqual((merged['observed_jobs'], merged['missing_jobs'], merged['infra_failures']), (2, 1, 1))
        self.assertEqual(merged['task_status'], {'INFRA_ERROR': 1, 'PASSED': 1})
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            C['merge']([a, a], scheduled_total=2)


# 2026-10-20: a boxes.dev service restart killed the sharded operator (coordinator)
# and both host runners after the global release while 60 guests ran on Fly. Only
# the guest supervisors survived: the cross-shard 5% stop (3/60), the live
# shard-status counters (scorecard frozen at "COMPLETED 0/60") and the exact
# supervisor TERM path had no owner.
ADOPTER = r"""
import json,os,runpy,shlex,subprocess,sys
from pathlib import Path
R=runpy.run_path(sys.argv[1])
class ExecAPI:
    def __init__(self,mid):self.mid=mid
    def api(self,method,path,body,timeout):
        assert method=='POST' and path=='/machines/'+self.mid+'/exec'
        p=subprocess.run(shlex.split(body['cmd']),capture_output=True,text=True,env=dict(os.environ,FLY_MACHINE_ID=self.mid),timeout=10)
        return dict(stdout=p.stdout,stderr=p.stderr,exit_code=p.returncode)
raise SystemExit(R['adopt_live'](Path(sys.argv[2]),api=ExecAPI(sys.argv[3]),probe_interval=0.2))
"""
SUPERVISOR = r"""
import json,signal,sys,time
from pathlib import Path
identity=Path(sys.argv[1])
def joined(*unused):
    row=json.loads(identity.read_text());row.update(supervisor_joined=True,supervisor_exit_code=7)
    identity.with_suffix('.terminal.json').write_text(json.dumps(row));sys.exit(7)
signal.signal(signal.SIGTERM,joined);print('ready',flush=True)
while True:time.sleep(.05)
"""


def killed_process():
    """A process that existed with a recorded birth and was then killed (service restart)."""
    import subprocess, sys
    process = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
    born = R['birth'](process.pid)
    process.kill()
    process.wait(timeout=5)
    return process.pid, born


class HostDeathAdoption(unittest.TestCase):
    """The global infra stop and live observation are re-adoptable after host death."""

    def fixture(self, root, infra_per_shard, scheduled_total=60):
        import subprocess, sys, time
        root = Path(root)
        admission = root / 'admission'
        admission.mkdir(mode=0o700)
        shards, supervisors, release_id = [], [], 'ab' * 12
        for index, infra in enumerate(infra_per_shard):
            mid = '1234567890abc%d' % index
            guest = root / ('guest-%d' % index)
            guest.mkdir()
            identity = guest / 'original600-supervisor.fixture.json'
            process = subprocess.Popen([sys.executable, '-c', SUPERVISOR, str(identity), 'cloudbench-original600-supervisor.py'],
                                       stdout=subprocess.PIPE, text=True)
            row = dict(schema='original600-supervisor-identity-v1', pid=process.pid, birth=R['birth'](process.pid),
                       machine=mid, source_ref='a' * 40, epoch=1.0)
            R['save'](identity, row)
            self.assertEqual(process.stdout.readline().strip(), 'ready')
            supervisors.append((process, identity))
            barrier = identity.with_suffix('.barrier')
            barrier.mkdir(mode=0o700)
            (barrier / 'ready.json').write_text(json.dumps(dict(schema='campaign-external-barrier-ready-v1', status='released')))
            progress = dict(combos=[['passed', 'PASSED', False, 9 - index], ['running', None, None, 21 + index]], jobs=30,
                            terminal_attempts=9 - index, infra_attempts=0, reasons=[])
            R['save'](identity.with_suffix('.infra.json'), dict(schema='original600-shard-infra-v1', infra_true=infra,
                                                               unique_jobs=30, observed_at=time.time(), progress=progress))
            out = admission / ('shard-%02d' % index) / 'run'
            out.mkdir(mode=0o700, parents=True)
            R['save'](out / 'authority.private.json', dict(allowed=True, source_ref='a' * 40, protected_machines=['8ed16dc75ee958']))
            auth_sha = R['sha'](R['read'](out / 'authority.private.json'))
            runner_pid, runner_birth = killed_process()
            gate_pid, gate_birth = killed_process()
            R['save'](out / 'caller.json', dict(pid=runner_pid, birth=runner_birth, gate_pid=gate_pid, gate_birth=gate_birth,
                                                source_ref='a' * 40, task_ref='b' * 40, epoch=1.0, deadline=time.time() + 3600,
                                                identity_path=str(identity), authority_sha256=auth_sha))
            R['save'](out / 'controller.identity.json', dict(machine=mid, instance='01FIXTURE', source_ref='a' * 40,
                                                             authority_sha256=auth_sha))
            R['save'](out / 'global-release.json', dict(release_id=release_id, reason='all 2 shards ready'))
            # The dead runner's last status: frozen before any task finished.
            R['save'](out / 'shard-status.json', dict(schema='original600-shard-status-v1', state='LIVE', machine=mid,
                                                     observed_at=1.0, barrier=dict(status='released'),
                                                     infra=dict(infra_true=0, progress=dict(combos=[['running', None, None, 30]]))))
            shards.append(dict(index=index, out=str(out), pid=runner_pid, mid=mid))
        journal = admission / 'coordination.json'
        original = dict(schema='original600-shard-coordination-v1', release_id=release_id, controllers=len(shards),
                        scheduled_total=scheduled_total, infra_early_stop='enabled', started_at=100.0, released_at=200.0,
                        aborted_at=None, abort_reason=None, terminated_at=None, terminate_reason=None, retries=[], infra_true=0,
                        shards={str(s['index']): dict(out=s['out'], pid=s['pid']) for s in shards})
        C['save'](journal, original)
        return admission, journal, shards, supervisors

    def close(self, supervisors):
        for process, unused in supervisors:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
            process.stdout.close()

    def test_cross_shard_infra_threshold_survives_killed_operator_and_runners(self):
        import subprocess, sys
        runner_path = ROOT / 'scripts/cloudbench-original600-runner.py'
        scorecard = runpy.run_path(str(ROOT / 'scripts/cloudbench-scorecard.py'))
        with tempfile.TemporaryDirectory() as name:
            # 2 + 1 = 3 of 60: only the cross-shard sum reaches the 5% threshold.
            admission, journal, shards, supervisors = self.fixture(name, (2, 1))
            adopters = []
            try:
                frozen = scorecard['load_sharded'](admission, deep=False)
                self.assertEqual(frozen['outcomes']['PASS'], 0)

                def spawn(shard):
                    mid = next(s['mid'] for s in shards if s['index'] == shard['index'])
                    process = subprocess.Popen([sys.executable, '-c', ADOPTER, str(runner_path), str(shard['out']), mid],
                                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                    adopters.append(process)
                    return process

                original = json.loads(journal.read_bytes())
                record = C['coordinate']([dict(index=s['index'], out=Path(s['out'])) for s in shards], spawn, journal,
                                         scheduled_total=60, adopt=original, poll_seconds=0.1)
                for process, identity in supervisors:
                    self.assertEqual(process.wait(timeout=10), 7, 'adopted owner TERMed the exact supervisor')
                    self.assertTrue(identity.with_suffix('.terminal.json').exists())
                self.assertEqual(record['terminate_reason'], 'infra 3/60 reached the 5% threshold')
                self.assertEqual((record['release_id'], record['started_at'], record['released_at']),
                                 (original['release_id'], 100.0, 200.0), 'original clocks and release identity preserved')
                self.assertEqual(record['infra_true'], 3)
                self.assertEqual(len(record['adoptions']), 1)
                self.assertEqual({k: v['pid'] for k, v in record['adoptions'][0]['previous_shards'].items()},
                                 {str(s['index']): s['pid'] for s in shards})
                self.assertEqual(record['exit_codes'], {'0': 0, '1': 0})
                for shard in shards:
                    out = Path(shard['out'])
                    intent = json.loads(R['read'](out / 'supervisor-term.intent.json'))
                    self.assertEqual((intent['machine'], intent['signal']), (shard['mid'], 'SIGTERM'))
                    receipt = json.loads(R['read'](out / 'adoption-01.json'))
                    self.assertEqual(receipt['original_owner_pid'], shard['pid'])
                    self.assertEqual(json.loads(R['read'](out / 'adoption-01.terminal.json'))['supervisor_state'], 'JOINED')
                    self.assertFalse((out / 'terminal.json').exists(), 'cleanup stays with the dead-owner release route')
                    self.assertTrue(list(out.glob('supervisor-probe-[0-9][0-9][0-9][0-9][0-9][0-9].json')))
                live = scorecard['load_sharded'](admission, deep=False)
                self.assertEqual(live['rows_source'], 'live shard-status counters')
                self.assertEqual(live['outcomes']['PASS'], 17,
                                 'the scorecard resumes the supervisors\' live counters')
            finally:
                for process in adopters:
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=5)
                    process.stdout.close()
                self.close(supervisors)

    def test_operator_adopt_live_check_binds_the_original_run_without_writing(self):
        import contextlib, io
        operator = runpy.run_path(str(ROOT / 'scripts/run-original600-controller.py'))
        with tempfile.TemporaryDirectory() as name:
            admission, journal, shards, supervisors = self.fixture(name, (0, 0))
            try:
                before = sorted(str(p) for p in admission.rglob('*'))
                printed = io.StringIO()
                with contextlib.redirect_stdout(printed):
                    code = operator['adopt_live_sharded'](['--adopt-live', str(admission), '--check', '--workspace', name])
                self.assertEqual(code, 0)
                plan = json.loads(printed.getvalue().splitlines()[-1])
                self.assertEqual((plan['status'], plan['scheduled_total'], plan['release_id']), ('ADOPT_LIVE_PLAN', 60, 'ab' * 12))
                self.assertEqual([s['dead_runner_pid'] for s in plan['shards']], [s['pid'] for s in shards])
                self.assertEqual(sorted(str(p) for p in admission.rglob('*')), before, '--check writes nothing')
            finally:
                self.close(supervisors)

    def test_adoption_refuses_a_live_original_owner_terminal_runner_or_finished_coordination(self):
        import time
        with tempfile.TemporaryDirectory() as name:
            admission, journal, shards, supervisors = self.fixture(name, (0,))
            try:
                out = Path(shards[0]['out'])
                caller = json.loads(R['read'](out / 'caller.json'))
                self.assertEqual(R['adoption_binding'](out)['machine'], shards[0]['mid'])
                (out / 'caller.json').unlink()
                R['save'](out / 'caller.json', dict(caller, pid=os.getpid(), birth=R['birth'](os.getpid())))
                with self.assertRaisesRegex(ValueError, 'original runner owner still live'):
                    R['adoption_binding'](out)
                (out / 'caller.json').unlink()
                R['save'](out / 'caller.json', caller)
                R['save'](out / 'terminal.json', dict(status='CONTROLLER_RELEASE_VERIFIED'))
                with self.assertRaisesRegex(ValueError, 'already terminal'):
                    R['adoption_binding'](out)
                finished = dict(json.loads(journal.read_bytes()), finished_at=time.time(), exit_codes={})
                with self.assertRaisesRegex(ValueError, 'already finished'):
                    C['coordinate']([dict(index=0, out=out)], lambda shard: None, journal, scheduled_total=60, adopt=finished)
            finally:
                self.close(supervisors)


if __name__ == '__main__':
    unittest.main()
