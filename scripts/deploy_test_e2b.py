"""Collect a completed native E2B domain failure; never grant positive credit."""
import hashlib
import json
import math
from pathlib import Path


COMMAND = ['bash', 'scripts/run-deploy-semantic-stack.sh', '--e2b-smoke-only']


def artifacts(root):
    return set((root / '.context/deploy-e2b-smoke').glob('*'))


def completed_failure(root, before, progress_path, progress_before, started, finished):
    """Require the native runner's exact, non-aborted single-domain result.

    This mirrors backend domain collection, but is negative-only. Missing,
    conflicting, aborted or flaky evidence stays UNVERIFIED in the caller.
    Source and owned cleanup remain enforced by the enclosing worker.
    """
    try:
        created = artifacts(root) - before
        if len(created) != 1:
            return None
        directory = created.pop()
        if directory.is_symlink() or not directory.is_dir():
            return None
        paths = [directory / 'summary.json', directory / 'claude-code.log']
        if any(path.is_symlink() or not path.is_file() for path in paths):
            return None
        raw = paths[0].read_bytes()
        summary = json.loads(raw)
        if (not isinstance(summary, dict) or summary.get('requested') != ['claude-code']
                or type(summary.get('passed')) is not int or summary['passed'] != 0
                or type(summary.get('failed')) is not int or summary['failed'] != 1
                or not isinstance(summary.get('runId'), str) or not summary['runId']
                or not isinstance(summary.get('results'), list) or len(summary['results']) != 1):
            return None
        row = summary['results'][0]
        if (not isinstance(row, dict) or row.get('domain') != 'claude-code'
                or row.get('passed') is not False or row.get('aborted') is not False
                or row.get('flaky') is not False or type(row.get('attempts')) is not int
                or row['attempts'] not in (1, 2) or row.get('logPath') != str(paths[1])
                or type(row.get('duration')) not in (int, float)
                or not math.isfinite(row['duration']) or row['duration'] <= 0):
            return None
        completions = sorted(directory.glob('claude-code-completion-*.json'))
        if row.get('terminations') != [dict(kind='exited', code=1, signal=None)] * row['attempts']:
            return None
        if len(completions) != row['attempts'] or any(path.is_symlink() for path in completions):
            return None
        attempts = [json.loads(path.read_bytes()) for path in completions]
        identities = None
        for attempt in attempts:
            if (attempt.get('runId') != summary['runId'] or attempt.get('domain') != 'claude-code'
                    or not isinstance(attempt.get('results'), list) or not attempt['results']
                    or type(attempt.get('completedAt')) not in (int, float)
                    or not math.isfinite(attempt['completedAt'])
                    or not started * 1000 <= attempt['completedAt'] <= finished * 1000):
                return None
            results = attempt['results']
            names = [result['name'] for result in results]
            if (any(not isinstance(name, str) or not name for name in names)
                    or len(set(names)) != len(names) or identities is not None and names != identities
                    or any(type(result.get('passed')) is not bool or result.get('skipped') is not None
                           or (result.get('passed') is False and
                               (not isinstance(result.get('error'), str) or not result['error']))
                           for result in results)):
                return None
            identities = names
            passed = sum(result['passed'] for result in results)
            failed = len(results) - passed
            if (failed == 0 or attempt.get('summary') !=
                    {'passed': passed, 'failed': failed, 'skipped': 0, 'exitCode': 1}):
                return None
        attempts.sort(key=lambda attempt: attempt['completedAt'])
        if len({attempt['completedAt'] for attempt in attempts}) != len(attempts):
            return None
        cleanup_path = directory / 'cleanup.json'
        if cleanup_path.is_symlink():
            return None
        cleanup = json.loads(cleanup_path.read_bytes())
        sandbox = cleanup.get('sandbox')
        if (cleanup.get('runId') != summary['runId'] or cleanup.get('backendTreeCleaned') is not True
                or not isinstance(sandbox, dict) or sandbox.get('roseStack') != 'blackbox:' + summary['runId']
                or sandbox.get('verified') is not True or sandbox.get('remaining') != []):
            return None
        progress = Path(progress_path).read_bytes()
        if not progress.startswith(progress_before):
            return None
        events = [json.loads(line) for line in progress[len(progress_before):].splitlines()]
        domains = [event for event in events if event.get('scope') == 'domain']
        if (len(domains) != 1 or domains[0].get('v') != 1
                or domains[0].get('unit') != 'claude-code'
                or domains[0].get('case') != 'e2b-smoke' or domains[0].get('status') != 'FAIL'):
            return None
        return {'positive_credit': False, 'summary': summary, 'domain_event': domains[0],
                'attempts': attempts, 'cleanup': cleanup,
                'files': {str(paths[0]): hashlib.sha256(raw).hexdigest(),
                          **{str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                             for path in [paths[1], *completions, cleanup_path]}},
                'progress_sha256': hashlib.sha256(progress).hexdigest()}
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        return None
