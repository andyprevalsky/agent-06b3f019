#!/usr/bin/env python3
"""One run-bench launch of a wide batch as sequential bounded sharded waves.

run-bench routes here when an explicit --concurrency C exceeds one controller's
copy bound but is below the batch's copies (tasks x K). The ordered manifest is
split into task-aligned waves of floor(C/K) tasks (every copy of a task stays in
one wave), so at most C copies run at once. Each wave is one normal sharded
operator launch (--check, then --run) at the same pushed source, task timeout
and e2e budget. The batch remains one logical unit:

* the fixed 5% infra stop uses the batch's ORIGINAL scheduled copies; every wave
  receives that denominator plus the confirmed infra jobs of its earlier waves,
  and no wave launches once 20 * infra >= scheduled_total;
* the next wave starts only after the previous operator returned AND its
  native-release-audit.json proves every owned resource released;
* any stop (threshold, abort, unverified release, signal, operator failure)
  leaves the remaining waves explicitly NOT_LAUNCHED;
* the aggregate batch.json is the parent record. A wave's PASS never makes the
  batch complete: batch_complete requires every wave joined and released with
  no missing job.

Usage (run-bench builds it):
  run-bench-sharded-waves.py --state-dir D --tasks M --runs K --concurrency C [--check] -- OPERATOR... -- OPERATOR-ARGS...
OPERATOR-ARGS must not contain --tasks/--run/--scheduled-total/--prior-infra.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

SCHEMA = 'run-bench-sharded-waves-v1'
RESERVED = ('--tasks', '--run', '--scheduled-total', '--prior-infra')


def need(value, message):
    if not value:
        raise ValueError(message)


def save(path, value):
    """Atomic private replacement of one small JSON record."""
    path = Path(path)
    temporary = path.with_name('.' + path.name + '.' + str(os.getpid()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, indent=1, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def infra_stop_reached(infra_jobs, scheduled_total):
    """The batch's fixed-total stop (the coordinator's rule): 20 * infra >= original scheduled copies."""
    return scheduled_total > 0 and 20 * infra_jobs >= scheduled_total


def plan_waves(tasks, runs, concurrency):
    """Ordered, task-aligned waves of at most `concurrency` simultaneous copies."""
    need(isinstance(tasks, list) and tasks and all(isinstance(t, str) and t for t in tasks)
         and len(set(tasks)) == len(tasks), 'ordered distinct task names required')
    need(type(runs) is int and runs >= 1, 'positive repetitions required')
    need(type(concurrency) is int and runs <= concurrency < len(tasks) * runs,
         'bounded waves need repetitions <= --concurrency < tasks x repetitions')
    width = concurrency // runs
    return [tasks[i:i + width] for i in range(0, len(tasks), width)]


def operator_lines(text):
    """The operator's JSON status lines (other output is human text)."""
    for line in text.splitlines():
        line = line.strip()
        if line.startswith('{'):
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict):
                yield value


def released(admission, finished_after):
    """True only for a fresh native-release-audit.json of this admission that proves full release."""
    try:
        audit = json.loads((Path(admission) / 'native-release-audit.json').read_text())
    except (OSError, ValueError):
        return False
    observed = audit.get('observed_at')
    return (audit.get('released') is True and type(observed) in (int, float) and observed >= finished_after)


class Batch:
    def __init__(self, args, operator, operator_args):
        self.args, self.operator, self.operator_args = args, operator, operator_args
        tasks = json.loads(Path(args.tasks).read_text())
        self.waves = plan_waves(tasks, args.runs, args.concurrency)
        self.scheduled_total = len(tasks) * args.runs
        state = Path(args.state_dir).absolute()
        need(state.is_dir() and not state.stat().st_mode & 0o077, 'private state directory required')
        self.directory = state / ('waves-%s-%d' % (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()), os.getpid()))
        self.directory.mkdir(mode=0o700)
        self.child = None
        self.stop = None
        self.record = dict(
            schema=SCHEMA, mode='check' if args.check else 'run', created_at=time.time(),
            tasks=tasks, runs=args.runs, concurrency=args.concurrency, scheduled_total=self.scheduled_total,
            operator_args=operator_args, infra_confirmed=0, infra_stop_reached=False, stop_reason=None,
            waves=[dict(index=i, tasks=w, copies=len(w) * args.runs, state='PLANNED') for i, w in enumerate(self.waves)],
            unlaunched_copies=self.scheduled_total, batch_complete=False, acceptance_credit=False)
        for wave in self.record['waves']:
            manifest = self.directory / ('wave-%02d-tasks.private.json' % wave['index'])
            fd = os.open(manifest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as stream:
                json.dump(wave['tasks'], stream)
            wave['manifest'] = str(manifest)
        self.publish()

    def publish(self):
        waves = self.record['waves']
        self.record['unlaunched_copies'] = sum(w['copies'] for w in waves if w['state'] in ('PLANNED', 'NOT_LAUNCHED', 'CHECKED', 'CHECK_REFUSED'))
        self.record['batch_complete'] = (self.record['mode'] == 'run' and all(
            w['state'] == 'RELEASED' and w.get('exit_code') == 0 and w.get('missing_jobs') == 0 for w in waves))
        self.record['observed_at'] = time.time()
        save(self.directory / 'batch.json', self.record)

    def request_stop(self, number, _frame):
        first = self.stop is None
        self.stop = self.stop or signal.Signals(number).name
        if first and self.child is not None and self.child.poll() is None:
            # One TERM to the exact owned operator; its own traps clean up. Repeated signals
            # never re-signal it (a second TERM can strand cleanup).
            self.child.send_signal(signal.SIGTERM)

    def operator_call(self, wave, mode):
        argv = [*self.operator, *self.operator_args, '--tasks', wave['manifest'],
                '--scheduled-total', str(self.scheduled_total), '--prior-infra', str(self.record['infra_confirmed'])]
        if mode == 'run':
            argv.append('--run')
        log = self.directory / ('wave-%02d-%s.log' % (wave['index'], mode))
        with open(log, 'w') as stream:
            self.child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                          text=True, start_new_session=True)
            output = []
            for line in self.child.stdout:
                sys.stdout.write(line)
                sys.stdout.flush()
                stream.write(line)
                output.append(line)
            code = self.child.wait()
            self.child = None
        return code, ''.join(output)

    def halt(self, reason):
        self.record['stop_reason'] = self.record['stop_reason'] or reason
        for wave in self.record['waves']:
            if wave['state'] in ('PLANNED', 'CHECKED'):
                wave['state'] = 'NOT_LAUNCHED'
        self.publish()

    def run_wave(self, wave):
        code, output = self.operator_call(wave, 'check')
        checks = [v for v in operator_lines(output) if v.get('status') == 'CHECKED_NOT_LAUNCHED']
        if code != 0 or not checks:
            wave['state'], wave['check_exit_code'] = 'CHECK_REFUSED', code
            return 'wave %d --check refused (exit %d)' % (wave['index'], code)
        wave['state'] = 'CHECKED'
        wave['check'] = {k: checks[-1].get(k) for k in ('source_ref', 'task_ref', 'manifest', 'wave', 'controllers', 'copies')}
        self.publish()
        if self.args.check:
            return None
        if self.stop:
            return 'operator ' + self.stop
        wave['state'], wave['started_at'] = 'LAUNCHED', time.time()
        self.publish()
        code, output = self.operator_call(wave, 'run')
        finished = time.time()
        lines = list(operator_lines(output))
        admissions = [v['directory'] for v in lines if v.get('status') == 'SHARDED_ADMISSION_STARTED']
        wave.update(exit_code=code, finished_at=finished, admission_dir=admissions[-1] if admissions else None)
        result = None
        if wave['admission_dir']:
            try:
                result = json.loads((Path(wave['admission_dir']) / 'result.json').read_text())
            except (OSError, ValueError):
                result = None
        if result is None:
            wave['state'] = 'FAILED_NO_RESULT'
            return 'wave %d ended without a result (exit %d)' % (wave['index'], code)
        coordination = result.get('coordination') or {}
        wave.update(observed_jobs=result.get('observed_jobs'), missing_jobs=result.get('missing_jobs'),
                    infra_failures=result.get('infra_failures'), task_status=result.get('task_status'),
                    shards_without_summary=result.get('shards_without_summary') or [],
                    abort_reason=coordination.get('abort_reason'), terminate_reason=coordination.get('terminate_reason'))
        exported, live = result.get('infra_failures'), coordination.get('infra_true', 0)
        if type(exported) is not int or exported < 0 or type(live) is not int or live < 0:
            wave['state'] = 'FAILED_NO_RESULT'
            return 'wave %d result has no confirmed infra count' % wave['index']
        # Both count confirmed infra jobs of this wave only: a shard whose export is missing
        # still keeps the coordinator's live confirmed count, never an undercount.
        infra = wave['infra_confirmed'] = max(exported, live)
        self.record['infra_confirmed'] += infra
        self.record['infra_stop_reached'] = infra_stop_reached(self.record['infra_confirmed'], self.scheduled_total)
        wave['state'] = 'JOINED'
        if not released(wave['admission_dir'], wave['started_at']):
            return 'wave %d release not verified by native-release-audit.json' % wave['index']
        wave['state'] = 'RELEASED'
        if self.record['infra_stop_reached']:
            return 'infra %d/%d reached the 5%% threshold' % (self.record['infra_confirmed'], self.scheduled_total)
        if wave['abort_reason'] or wave['terminate_reason']:
            return 'wave %d stopped: %s' % (wave['index'], wave['abort_reason'] or wave['terminate_reason'])
        if wave['missing_jobs'] != 0 or wave['shards_without_summary']:
            return 'wave %d incomplete: %s missing jobs, shards without summary %s' % (
                wave['index'], wave['missing_jobs'], wave['shards_without_summary'])
        if code != 0:
            return 'wave %d operator failed (exit %d)' % (wave['index'], code)
        if self.stop:
            return 'operator ' + self.stop
        return None

    def run(self):
        previous = {s: signal.signal(s, self.request_stop) for s in (signal.SIGTERM, signal.SIGINT)}
        try:
            print(json.dumps(dict(status='SHARDED_WAVES_STARTED', batch=str(self.directory / 'batch.json'),
                                  waves=[len(w) for w in self.waves], scheduled_total=self.scheduled_total,
                                  concurrency=self.args.concurrency)), flush=True)
            for wave in self.record['waves']:
                reason = self.run_wave(wave)
                self.publish()
                if reason:
                    self.halt(reason)
                    break
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)
            self.record['ended_at'] = time.time()
            self.publish()
        print(json.dumps(dict(status='SHARDED_WAVES_ENDED', batch=str(self.directory / 'batch.json'),
                              mode=self.record['mode'], waves={w['index']: w['state'] for w in self.record['waves']},
                              infra_confirmed=self.record['infra_confirmed'], scheduled_total=self.scheduled_total,
                              unlaunched_copies=self.record['unlaunched_copies'], stop_reason=self.record['stop_reason'],
                              batch_complete=self.record['batch_complete'])), flush=True)
        print('🧾 one batch scorecard over every wave (the user-facing outcome; wave cards are evidence only):\n'
              '   scripts/run-bench scorecard %s --html %s' % (self.directory, self.directory / 'scorecard.html'), flush=True)
        if self.args.check:
            return 0 if all(w['state'] == 'CHECKED' for w in self.record['waves']) else 2
        return 0 if self.record['batch_complete'] else 1


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    need(argv.count('--') >= 2, 'usage: ... -- OPERATOR... -- OPERATOR-ARGS...')
    first = argv.index('--')
    second = argv.index('--', first + 1)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--tasks', required=True)
    parser.add_argument('--runs', type=int, required=True)
    parser.add_argument('--concurrency', type=int, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args(argv[:first])
    operator, operator_args = argv[first + 1:second], argv[second + 1:]
    need(operator, 'operator command required')
    need(not any(a in RESERVED or a.split('=', 1)[0] in RESERVED for a in operator_args),
         'the wave driver owns --tasks/--run/--scheduled-total/--prior-infra')
    return Batch(args, operator, operator_args).run()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except ValueError as error:
        print('❌ ' + str(error), file=sys.stderr)
        raise SystemExit(2)
