#!/usr/bin/env python3
"""Test quarantine: markers in the test definitions, FLAKY attribution and release streaks.

A quarantined test carries its marker in its own definition (Python
``@quarantine(since=, repair=, error=, evidence=)`` from scripts/lib/test_quarantine.py,
TypeScript ``quarantine(meta, fn)``, a smoke benchmark task's ``quarantine`` object in
agents/benchmarks/tasks.json). It still runs; its rows are QUARANTINED_FAIL or
QUARANTINED_PASS and never fail a gate. A non-quarantined unit that failed and passed
its single rerun is FLAKY: it still needs /RCA attribution before merge.

    progress.jsonl rows ──> deploy_test_cycle (results, FLAKY attribution, scorecard line)
                       └──> record_factory_event stage-finish detail.tests (factory ledger)
    markers in tree + recorded rows ──> `report`: consecutive-pass streak, ready to release at 5

Stdlib only. ``report`` reads the factory ledger (durable, on main) and local deploy
attempt progress files; it never edits a test. The CLI is ``scripts/test_quarantine.py report``;
this module has a distinct name so it never shadows the marker module
``scripts/lib/test_quarantine.py`` when both directories are on sys.path.
"""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import deploy_gate_progress as progress
from deploy_gate_progress import flaky, quarantined

ROOT = Path(__file__).resolve().parents[1]
QUARANTINED_FAIL, QUARANTINED_PASS = progress.QUARANTINED
FLAKY, QUARANTINED, BLOCKING = progress.FLAKY, progress.QUARANTINED, progress.BLOCKING
RELEASE_PASSES = 5
DETAIL_LIMIT = 2000
LINE_LIMIT = 160
META_KEYS = ('since', 'repair', 'error', 'evidence')
LEDGER = Path('agents/benchmarks/history/factory_events.jsonl')
# Smoke benchmark tasks carry their marker as a `quarantine` object on their catalog entry.
CATALOG = Path('agents/benchmarks/tasks.json')
MARKER_MODULE = Path(__file__).resolve().parent / 'lib' / 'test_quarantine.py'
LOCAL_EVENTS = Path('.context/factory-events.jsonl')
STATE_DIR_ENV = 'DEPLOY_TEST_CYCLE_STATE_DIR'
DEFAULT_STATE_DIR = Path('.context/deploy-pipeline')
# Line order in bounded ledger detail: a failing test name is never the one dropped.
PRIORITY = {'FAIL': 0, 'UNVERIFIED': 0, FLAKY: 1, QUARANTINED_FAIL: 2, QUARANTINED_PASS: 3}
SCAN_EXCLUDE = ('claude-code-src/', 'openclaw/', 'hermes-agent/', 'codex/', 'prime-agent/', 'kimi-code/', 'openworker/',
                'node_modules/', 'scripts/lib/test_quarantine.py')
BOXES_THREAD = re.compile(r'https://boxes\.dev/thread/[A-Za-z0-9_-]+')

USER_DEPLOY_KIND = 'user-deploy-quarantine-v1'
USER_DEPLOY_DISPOSITION = 'USER_DEPLOY_QUARANTINE'
USER_DEPLOY_CASE = 'test-mass-agent-run-0'
# Last frozen pre-enforcement source; only its authenticated ancestors have no policy projection.
USER_DEPLOY_BEFORE_HEAD = '4185ac910f39babfbf28d0ed531f1f0b337bbaa3'
USER_DEPLOY_REASON = ('User-directed indefinite exclusion from all deploys (2026-11-10, PR1682): '
                     'flaky mass-agent test. Keep explicit benchmark execution and historical '
                     'failures; do not count this omission as PASS.')
USER_DEPLOY_INSTRUCTION = {'role': 'user', 'turn': '01a1c787-5a6e-7c12-a3be-4b5ac96b5d38',
                           'thread': 'ph78kfk10r8j8fpxxcp5tc43xd8h2x6q',
                           'message_time_ms': 1794348964530}


def _deploy_catalog(root: Path, historical_head: str | None = None) -> tuple[bytes, list]:
    path = root / CATALOG
    if historical_head is None:
        raw = path.read_bytes() if path.is_file() else b'[]'
    else:
        if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', historical_head):
            raise ValueError('invalid historical deploy quarantine source')
        try:
            raw = subprocess.check_output(['git', '--no-replace-objects', '-C', str(root), 'show',
                                           historical_head + ':' + CATALOG.as_posix()], stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            raise ValueError('historical deploy quarantine catalog unavailable') from None
    rows = json.loads(raw)
    if (not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get('name'), str)
                                        or not row['name'] for row in rows)
            or len({row['name'] for row in rows}) != len(rows)):
        raise ValueError('deploy quarantine catalog needs unique named tasks')
    return raw, rows


def catalog_deploy_quarantines(root: Path, names: list[str] | None = None, *,
                              historical_head: str | None = None) -> dict[str, str]:
    """Deploy-only selection policy; ordinary failure quarantines still execute."""
    _raw, rows = _deploy_catalog(root, historical_head)
    out = {}
    for row in rows:
        if 'deploy_quarantine' not in row:
            continue
        reason = row['deploy_quarantine']
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError('deploy_quarantine must be a nonempty reason string')
        if names is None or row['name'] in names:
            out[row['name']] = reason
    return out


def user_deploy_exclusions(root: Path, source: dict, gate: dict, input_fingerprint: str,
                          environment: str, *, historical_head: str | None = None) -> dict[str, dict]:
    """The verified named user instruction qualifies selection, never test execution."""
    if USER_DEPLOY_CASE not in gate.get('checks', []):
        return {}
    if gate.get('name') != 'smoke' or gate.get('category') != 'smoke' or gate.get('native_cloud') is not True:
        raise ValueError('user deploy quarantine requires its exact native smoke gate')
    if (not isinstance(source, dict) or set(source) != {'head', 'digest'}
            or not isinstance(source['head'], str) or not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', source['head'])):
        raise ValueError('user deploy quarantine source identity')
    head = historical_head or (source.get('head') if isinstance(source, dict) else None)
    reasons = catalog_deploy_quarantines(root, [USER_DEPLOY_CASE], historical_head=head)
    if USER_DEPLOY_CASE not in reasons and _git_ancestor(root, head, USER_DEPLOY_BEFORE_HEAD):
        return {}  # Reading old custody/receipts is not dispatch and must not acquire a new qualification.
    if reasons.get(USER_DEPLOY_CASE) != USER_DEPLOY_REASON:
        raise ValueError('named user deploy quarantine marker/authority missing or changed')
    inventory = gate.get('deploy_quarantine_inventory')
    if (inventory != {'kind': 'retained-user-deploy-quarantine-inventory-v1',
                      'checks': {USER_DEPLOY_CASE: USER_DEPLOY_REASON}, 'executed': False, 'credit_granted': False}
            or inventory.get('executed') is not False or inventory.get('credit_granted') is not False):
        raise ValueError('retained user deploy quarantine inventory changed')
    raw, _rows = _deploy_catalog(root, head)
    if (not isinstance(source, dict) or set(source) != {'head', 'digest'}
            or historical_head is not None and historical_head != source['head']
            or any(not isinstance(v, str) or not re.fullmatch(r'[0-9a-f]{64}', v)
                   for v in (source['digest'], input_fingerprint, environment))
            or not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', str(source['head']))):
        raise ValueError('user deploy quarantine source/input/environment binding')
    return {USER_DEPLOY_CASE: {'kind': USER_DEPLOY_KIND, 'disposition': USER_DEPLOY_DISPOSITION,
            'source': dict(source), 'gate': gate['name'], 'check': USER_DEPLOY_CASE,
            'input_fingerprint': input_fingerprint, 'environment': environment,
            'catalog_sha256': hashlib.sha256(raw).hexdigest(), 'reason': USER_DEPLOY_REASON,
            'instruction': dict(USER_DEPLOY_INSTRUCTION),
            'credit': {'test_execution': False, 'assertions': False, 'cleanup': False, 'financial_release': False}}}


def validate_user_deploy_receipt(root: Path, gate: dict, receipt: dict, request: dict) -> dict[str, dict]:
    """Authenticate only policy actually recorded on this immutable historical execution."""
    listed = {name: value for name, value in request.get('skips', {}).items()
              if isinstance(value, dict) and value.get('kind') == USER_DEPLOY_KIND}
    if USER_DEPLOY_CASE not in gate.get('checks', []):
        if listed or receipt.get('user_deploy_quarantine') or receipt.get('user_deploy_quarantine_execution'):
            raise ValueError('user deploy quarantine outside historical gate inventory')
        return {}
    reasons = catalog_deploy_quarantines(root, [USER_DEPLOY_CASE], historical_head=receipt['source']['head'])
    if USER_DEPLOY_CASE not in reasons:
        if not _git_ancestor(root, receipt['source']['head'], USER_DEPLOY_BEFORE_HEAD):
            raise ValueError('user deploy quarantine missing after enforcement source')
        if receipt.get('user_deploy_quarantine') or receipt.get('user_deploy_quarantine_execution'):
            raise ValueError('unbound user deploy quarantine receipt')
        if listed:
            raise ValueError('user deploy quarantine absent from historical catalog')
        return {}
    binding = receipt.get('execution_binding', {})
    expected = user_deploy_exclusions(root, receipt['source'], gate, binding.get('input_fingerprint'),
                                     binding.get('environment'), historical_head=receipt['source']['head'])
    for policy in (listed, receipt.get('user_deploy_quarantine', {})):
        if not isinstance(policy, dict):
            raise ValueError('invalid user deploy quarantine receipt')
        for value in policy.values():
            credit = value.get('credit') if isinstance(value, dict) else None
            if (not isinstance(credit, dict)
                    or set(credit) != {'test_execution', 'assertions', 'cleanup', 'financial_release'}
                    or any(type(flag) is not bool or flag is not False for flag in credit.values())):
                raise ValueError('user deploy quarantine requires explicit false credits')
    if (listed != expected or receipt.get('user_deploy_quarantine') != expected
            or receipt.get('user_deploy_quarantine_execution') != dict.fromkeys(expected, 'UNVERIFIED')
            or any(receipt.get('case_complete', {}).get(name) is not False
                   or receipt.get('cases', {}).get(name) != 'SKIP' for name in expected)):
        raise ValueError('user deploy quarantine receipt/input/credit changed')
    return expected


# --- progress rows -------------------------------------------------------------------------

def slim(row: dict) -> dict:
    """A bounded copy of one progress row for receipts and state (first detail line only)."""
    out = {k: row[k] for k in ('unit', 'case', 'scope', 'status', 'at', 'log') if k in row}
    detail = str(row.get('detail') or '').strip().splitlines()
    if detail:
        out['detail'] = detail[0][:300]
    for key in ('quarantine', 'attempts'):
        if key in row:
            out[key] = row[key]
    return out


def gate_outcomes(path: Path) -> dict:
    """Quarantined and FLAKY rows of one gate attempt's progress file."""
    rows, _offset = progress.read_new(path, 0)
    return {'quarantined': [slim(r) for r in quarantined(rows)], 'flaky': [slim(r) for r in flaky(rows)]}


# --- scorecard -----------------------------------------------------------------------------

def quarantine_counts(results: list[dict]) -> tuple[int, int, int]:
    """(units, failed, passed) over the given gate receipts; each unit's latest row decides."""
    latest: dict[tuple, dict] = {}
    for result in results:
        for row in result.get('quarantined') or []:
            key = (result.get('gate'), row.get('unit'))
            if key not in latest or row.get('at', 0) >= latest[key].get('at', 0):
                latest[key] = row
    failed = sum(1 for r in latest.values() if r.get('status') == QUARANTINED_FAIL)
    return len(latest), failed, len(latest) - failed


def scorecard_lines(results: list[dict], flaky_occurrences: list[dict]) -> list[str]:
    units, failed, passed = quarantine_counts(results)
    lines = [f'Tests skipped (quarantined): {units} — {failed} failed (non-blocking), {passed} passed']
    if flaky_occurrences:
        attributed = sum(1 for f in flaky_occurrences if f.get('attribution'))
        lines.append(f'Flaky (passed on rerun): {len(flaky_occurrences)} — {attributed} attributed, '
                     f'{len(flaky_occurrences) - attributed} awaiting /RCA attribution (blocks merge)')
    return lines


def quarantine_section(results: list[dict]) -> list[str]:
    lines = []
    for result in results:
        for row in result.get('quarantined') or []:
            meta = row.get('quarantine') or {}
            lines.append(f"- {result.get('gate')} :: {row.get('unit')} — {row.get('status')}"
                         f" · since {meta.get('since', '?')} · repair {meta.get('repair', '?')}"
                         + (f" · {row['detail']}" if row.get('status') == QUARANTINED_FAIL and row.get('detail') else ''))
    return ['', 'QUARANTINED (non-blocking; the test ran)', *lines] if lines else []


# --- FLAKY attribution ---------------------------------------------------------------------

def _git_ancestor(root: Path, ancestor: str, descendant: str) -> bool:
    return subprocess.run(['git', 'merge-base', '--is-ancestor', ancestor, descendant], cwd=root,
                          capture_output=True).returncode == 0


def validate_attribution(occurrence: dict, entry: dict, root: Path) -> dict:
    """The recorded /RCA attribution of one FLAKY occurrence, or ValueError.

    INTRODUCED: fixed before merge (a commit in HEAD that the flaky source lacked), never quarantined.
    NOT_INTRODUCED: the unit's quarantine marker is in the tree naming its pending post-merge handoff
    (or an existing repair owner), and the post-merge packet is recorded with the attribution. UNKNOWN blocks.
    """
    attribution = entry.get('attribution')
    if attribution == 'UNKNOWN':
        raise ValueError('UNKNOWN keeps the FLAKY unit blocking; finish /RCA attribution')
    if attribution not in ('INTRODUCED', 'NOT_INTRODUCED'):
        raise ValueError('FLAKY attribution must be INTRODUCED or NOT_INTRODUCED')
    if not isinstance(entry.get('evidence'), str) or not entry['evidence'].strip():
        raise ValueError('FLAKY attribution requires the /RCA evidence reference')
    if attribution == 'INTRODUCED':
        fix = entry.get('fix_commit')
        if entry.get('marker') or entry.get('repair_agent') or entry.get('post_merge'):
            raise ValueError('an INTRODUCED flake is fixed before merge; it gets no quarantine or handoff')
        if not isinstance(fix, str) or not re.fullmatch(r'[0-9a-f]{7,40}', fix):
            raise ValueError('INTRODUCED requires fix_commit, the commit that fixes it')
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=root, capture_output=True, text=True).stdout.strip()
        flaky_head = (occurrence.get('source') or {}).get('head')
        if not _git_ancestor(root, fix, head) or (flaky_head and _git_ancestor(root, fix, flaky_head)):
            raise ValueError('fix_commit must be in HEAD and newer than the source that flaked')
        return {'attribution': attribution, 'evidence': entry['evidence'], 'fix_commit': fix}
    path = entry.get('marker')
    if not isinstance(path, str) or not path.strip() or Path(path).is_absolute() or '..' in Path(path).parts:
        raise ValueError('NOT_INTRODUCED requires marker: the repo-relative test file carrying the quarantine marker')
    found = [m for m in markers(root, [path]) if unit_matches(m, occurrence['unit'])]
    if not found:
        raise ValueError(f"no quarantine marker for {occurrence['unit']} in {path}")
    # Repairs are dispatched only after merge (deploy-failure-policy.md): a NOT_INTRODUCED flake records
    # its post-merge packet, never a pre-merge repair thread.
    if entry.get('repair_agent'):
        raise ValueError('NOT_INTRODUCED repairs dispatch after merge: record post_merge, not repair_agent')
    packet = entry.get('post_merge')
    if not isinstance(packet, dict) or any(not packet.get(k) for k in ('test', 'command', 'scope', 'error',
                                                                        'source', 'evidence')):
        raise ValueError('a post-merge packet requires test, command, scope, error, source and evidence')
    owner = packet.get('repair_owner')
    expected = owner if owner else f"pending-handoff:{occurrence['id']}"
    if owner and not BOXES_THREAD.fullmatch(owner):
        raise ValueError('repair_owner must be the existing boxes.dev repair thread that receives the goal after merge')
    if found[0]['repair'] not in (expected, f"pending-handoff:{occurrence['id']}"):
        raise ValueError(f"the marker's repair must be {expected} until the post-merge dispatch is linked")
    # The attribution travels with the handoff: the dispatched /goal carries the /RCA gate and evidence.
    packet = {**packet, 'attribution': 'NOT_INTRODUCED', 'rca': entry['evidence'], 'occurrence': occurrence['id'],
              'unit': occurrence['unit'], 'gate': occurrence.get('gate'), 'marker': path}
    return {'attribution': attribution, 'evidence': entry['evidence'], 'marker': path, 'post_merge': packet}


def link_repair(root: Path, occurrence_id: str, repair: str, paths: list[str] | None = None) -> list[str]:
    """After merge: replace `pending-handoff:<occurrence id>` with the dispatched repair thread in every
    marker that names it (Python/TS test files, agents/benchmarks/tasks.json). Returns the edited files."""
    if not re.fullmatch(r'[0-9a-f]{32}', occurrence_id):
        raise ValueError('occurrence id must be the 32-hex FLAKY occurrence')
    if not BOXES_THREAD.fullmatch(repair):
        raise ValueError('repair must be the dispatched boxes.dev thread URL')
    pending = f'pending-handoff:{occurrence_id}'
    candidates = list(paths) if paths is not None else [*_files(root, None), 'agents/benchmarks/tasks.json']
    edited = []
    for rel in dict.fromkeys(candidates):
        target = root / rel
        try:
            text = target.read_text()
        except (OSError, UnicodeDecodeError):
            continue
        if pending in text:
            target.write_text(text.replace(pending, repair))
            edited.append(rel)
    if not edited:
        raise ValueError(f'no marker names {pending}')
    return edited


def attribution_block(flaky_occurrences: list[dict], root: Path | None = None) -> str | None:
    """Merge refusal while any FLAKY unit lacks a recorded attribution; with root, it must still hold there."""
    missing = [f for f in flaky_occurrences if not f.get('attribution')]
    if missing:
        names = ', '.join(f"{f['gate']} :: {f['unit']}" for f in missing[:5])
        return (f'{len(missing)} FLAKY unit(s) lack /RCA attribution ({names}); record it with '
                'deploy_test_cycle.py attribute-flaky')
    for occurrence in flaky_occurrences if root is not None else []:
        try:
            validate_attribution(occurrence, occurrence['attribution'], root)
        except ValueError as error:
            return f"FLAKY {occurrence['gate']} :: {occurrence['unit']}: {error}"
    return None


# --- factory ledger lines ------------------------------------------------------------------

_UNSAFE = re.compile(r'[^A-Za-z0-9_.:/\[\]()<>=,+@#|~ -]')
_OPAQUE = re.compile(r'(?=[A-Za-z0-9+/=]*\d)(?=[A-Za-z0-9+/=]*[A-Za-z])[A-Za-z0-9+/=]{24,}|(?i:[a-f0-9]{24,})')


# Streak dedupe keys bound every unit to this tail; a ledger line's unit budget is never smaller.
UNIT_KEY_LIMIT = 64


def _sanitize(text: str) -> str:
    text = _UNSAFE.sub('?', ' '.join(str(text).split()))
    return _OPAQUE.sub('<redacted>', text)


def safe_line(text: str) -> str:
    """One bounded, secret-free ledger line: unsafe characters replaced, opaque tokens redacted."""
    return _sanitize(text)[:LINE_LIMIT]


def bounded_unit(unit: str, limit: int = LINE_LIMIT) -> str:
    """A sanitized unit of at most `limit` characters that keeps its trailing test name ('...' + tail)."""
    text = _sanitize(unit)
    return text if len(text) <= limit else '...' + text[len(text) - (limit - 3):]


def ledger_line(gate: str, row: dict) -> str:
    """`<status> <gate>::<unit> at=<epoch>` within LINE_LIMIT: only the unit's head is cut, never `at=`."""
    head, tail = _sanitize(f"{row['status']} {gate}::"), f" at={int(row.get('at') or 0)}"
    # Gate names are short fixed identifiers, so the budget is never below the streak key's tail.
    budget = max(UNIT_KEY_LIMIT, LINE_LIMIT - len(head) - len(tail))
    return head + bounded_unit(row['unit'], budget) + tail


def test_lines(rows: list[tuple[str, dict]], limit: int = DETAIL_LIMIT) -> dict:
    """Per-test ledger detail, failed tests first, whole lines kept within `limit` characters."""
    ordered = sorted(((g, r) for g, r in rows if r.get('status') in PRIORITY),
                     key=lambda pair: (PRIORITY[pair[1]['status']], pair[1].get('at') or 0))
    counts: dict[str, int] = {}
    lines, used = [], 0
    for gate, row in ordered:
        counts[row['status']] = counts.get(row['status'], 0) + 1
        line = ledger_line(gate, row)
        if used + len(line) + 1 > limit:
            continue
        lines.append(line)
        used += len(line) + 1
    return {'counts': counts, 'lines': lines, 'omitted': sum(counts.values()) - len(lines)}


def attempt_rows(attempts: Path, since: float = 0.0) -> list[tuple[str, dict]]:
    """(gate, row) for every progress row under <state>/attempts/<round>/<phase>/<gate>/progress.jsonl."""
    out = []
    for path in sorted(attempts.glob('*/*/*/progress.jsonl')):
        rows, _offset = progress.read_new(path, 0)
        out.extend((path.parent.name, r) for r in rows if (r.get('at') or 0) >= since)
    return out


def gate_outcome(receipt: dict) -> str:
    """One verdict per gate attempt. A gate killed by fail-fast (cancelled) or its deadline is not a test failure."""
    if receipt.get('cancelled'):
        return 'CANCELLED'
    if receipt.get('timed_out'):
        return 'TIMEOUT'
    if receipt.get('executed') is False:
        return 'NOT_RUN'
    if receipt.get('status') == 'PASS':
        return 'PASS'
    return 'FAIL' if receipt.get('complete') else 'UNVERIFIED'


def gate_rows(attempts: Path, since: float = 0.0) -> list[dict]:
    """Per-gate verdicts of the round, from each attempt's receipt.json (the cycle's own result, not a
    workflow status), so local and Blacksmith gates land in the ledger the same way."""
    out = []
    for path in sorted(attempts.glob('*/*/*/receipt.json')):
        try:
            receipt = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        started = receipt.get('started_at') or 0
        if not isinstance(receipt, dict) or started < since:
            continue
        finished = receipt.get('finished_at') or started
        out.append({'gate': receipt.get('gate') or path.parent.name, 'phase': path.parent.parent.name,
                    'round': path.parent.parent.parent.name, 'outcome': gate_outcome(receipt),
                    'native_exit': receipt.get('native_exit'),
                    'seconds': round(max(0.0, float(finished) - float(started)), 1)})
    return out


def state_dir(root: Path) -> Path:
    value = Path(os.environ.get(STATE_DIR_ENV) or DEFAULT_STATE_DIR)
    return value if value.is_absolute() else root / value


# --- markers -------------------------------------------------------------------------------

def _marker_module():
    """scripts/lib/test_quarantine.py (the decorator's validator), loaded by path so this CLI never shadows it."""
    name = 'test_quarantine'
    module = sys.modules.get(name)
    if module is not None and hasattr(module, 'validate_mapping'):
        return module
    spec = importlib.util.spec_from_file_location(name, MARKER_MODULE)
    if spec is None or spec.loader is None:
        raise ImportError(f'cannot load {MARKER_MODULE}')
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def catalog_quarantines(root: Path, names: list[str] | None = None) -> dict[str, dict]:
    """{task name: validated marker} for catalog tasks carrying `quarantine` (only `names` when given).

    An invalid marker raises ValueError (QuarantineMetadataError): the smoke adapter refuses before launch.
    """
    path = root / CATALOG
    if not path.is_file():
        return {}
    tasks = json.loads(path.read_text())
    if not isinstance(tasks, list):
        raise ValueError(f'{CATALOG} must be a JSON array of tasks')
    wanted = None if names is None else set(names)
    out = {}
    for task in tasks:
        if not isinstance(task, dict) or 'quarantine' not in task:
            continue
        name = task.get('name')
        if wanted is None or name in wanted:
            out[name] = _marker_module().validate_mapping(task['quarantine'], owner=str(name))
    return out


def _files(root: Path, paths: list[str] | None) -> list[str]:
    if paths is not None:
        return paths
    listed = subprocess.run(['git', 'ls-files', '-co', '--exclude-standard', '--', '*.py', '*.ts', '*.tsx'],
                            cwd=root, capture_output=True, text=True)
    files = [p for p in listed.stdout.splitlines() if not p.startswith(SCAN_EXCLUDE)]
    return files + ([str(CATALOG)] if (root / CATALOG).is_file() else [])


def _catalog_markers(rel: str, text: str) -> list[dict]:
    """Benchmark task markers; the unit is the task name (the smoke gate's progress-row unit)."""
    try:
        tasks = json.loads(text)
    except ValueError:
        return []
    found = []
    for task in tasks if isinstance(tasks, list) else []:
        meta = task.get('quarantine') if isinstance(task, dict) else None
        if not isinstance(meta, dict) or not isinstance(task.get('name'), str):
            continue
        hit = re.search(r'"name"\s*:\s*' + re.escape(json.dumps(task['name'])), text)
        found.append({'path': rel, 'line': text.count('\n', 0, hit.start()) + 1 if hit else 1,
                      'name': task['name'], 'owner': None, 'lang': 'benchmark',
                      **{k: meta.get(k) for k in META_KEYS}})
    return found


def _python_markers(rel: str, text: str) -> list[dict]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    found = []
    def visit(node, owner):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.ClassDef):
                visit(child, child.name)
            elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for deco in child.decorator_list:
                    fn = deco.func if isinstance(deco, ast.Call) else None
                    if (getattr(fn, 'id', None) or getattr(fn, 'attr', None)) != 'quarantine':
                        continue
                    meta = {}
                    for kw in deco.keywords:
                        try:
                            meta[kw.arg] = ast.literal_eval(kw.value)
                        except ValueError:
                            meta[kw.arg] = None
                    found.append({'path': rel, 'line': child.lineno, 'name': child.name, 'owner': owner,
                                  'lang': 'py', **{k: meta.get(k) for k in META_KEYS}})
                # Functions nested in a test body are not collected tests (e.g. the marker's own tests).
    visit(tree, None)
    return found


_STRING = re.compile(r"""(['"`])((?:\\.|(?!\1).)*)\1""", re.S)
_TS_MARKER = re.compile(r'\bquarantine\(\s*\{')


def _ts_markers(rel: str, text: str) -> list[dict]:
    found = []
    for match in _TS_MARKER.finditer(text):
        start = match.end() - 1
        depth, end = 0, start
        for end in range(start, min(len(text), start + 4000)):
            depth += {'{': 1, '}': -1}.get(text[end], 0)
            if depth == 0:
                break
        body = text[start:end + 1]
        meta = {}
        for key in META_KEYS:
            hit = re.search(key + r"""\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1""", body, re.S)
            meta[key] = hit.group(2) if hit else None
        names = _STRING.findall(text[max(0, match.start() - 500):match.start()])
        found.append({'path': rel, 'line': text.count('\n', 0, match.start()) + 1,
                      'name': names[-1][1] if names else None, 'owner': None, 'lang': 'ts', **meta})
    return found


def markers(root: Path, paths: list[str] | None = None) -> list[dict]:
    out = []
    for rel in _files(root, paths):
        try:
            text = (root / rel).read_text(errors='replace')
        except OSError:
            continue
        if Path(rel) == CATALOG:
            found = _catalog_markers(rel, text)
        elif 'quarantine(' not in text:
            continue
        else:
            found = _python_markers(rel, text) if rel.endswith('.py') else _ts_markers(rel, text)
        # A real marker carries all four values (the wrappers refuse anything less); usage examples do not.
        out.extend(m for m in found if all(isinstance(m.get(k), str) and m[k].strip() for k in META_KEYS))
    return out


def unit_matches(marker: dict, unit: str) -> bool:
    name = marker.get('name')
    if not name or not unit:
        return False
    base = re.sub(r'\[.*\]$', '', unit)  # pytest parametrisation
    return any(candidate == name or candidate.endswith(sep + name)
               for candidate in (unit, base, bounded_unit(unit))
               for sep in ('::', '.', ' > ', ' :: ', '/'))


# --- release report ------------------------------------------------------------------------

_LEDGER_LINE = re.compile(r'^(?P<status>\S+) (?P<gate>[A-Za-z0-9_.-]+)::(?P<unit>.+) at=(?P<at>\d+)$')


def ledger_observations(paths: list[Path]) -> list[dict]:
    out = []
    for path in paths:
        try:
            text = path.read_text()
        except OSError:
            continue
        for raw in text.splitlines():
            try:
                event = json.loads(raw)
            except ValueError:
                continue
            tests = ((event.get('detail') or {}).get('tests') if isinstance(event, dict) else None) or {}
            for line in tests.get('lines') or []:
                hit = _LEDGER_LINE.match(str(line))
                if hit and hit['status'] in QUARANTINED:
                    out.append({'status': hit['status'], 'gate': hit['gate'], 'unit': hit['unit'],
                                'at': int(hit['at'])})
    return out


def since_epoch(marker: dict) -> float:
    try:
        return datetime.strptime(str(marker.get('since')), '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return 0.0


def streak(marker: dict, observations: list[dict]) -> dict:
    """Consecutive QUARANTINED_PASS rows since the latest QUARANTINED_FAIL (rows before `since` ignored)."""
    floor = since_epoch(marker)
    seen = {}
    for obs in observations:
        if obs['status'] in QUARANTINED and (obs.get('at') or 0) >= floor and unit_matches(marker, obs['unit']):
            # ledger + local copy count once: the same bounded tail whether or not the ledger cut the unit
            seen[(bounded_unit(obs['unit'], UNIT_KEY_LIMIT), int(obs['at']), obs['status'])] = obs
    ordered = sorted(seen.values(), key=lambda o: o['at'])
    count = 0
    for obs in ordered:
        count = count + 1 if obs['status'] == QUARANTINED_PASS else 0
    return {'runs': len(ordered), 'streak': count, 'ready': count >= RELEASE_PASSES,
            'last': ordered[-1]['status'] if ordered else None}


def report(root: Path, ledgers: list[Path], attempts: list[Path]) -> list[dict]:
    observations = ledger_observations(ledgers)
    for directory in attempts:
        observations.extend({'status': r['status'], 'gate': g, 'unit': r['unit'], 'at': int(r.get('at') or 0)}
                            for g, r in attempt_rows(directory) if r.get('status') in QUARANTINED)
    rows = []
    for marker in markers(root):
        result = streak(marker, observations)
        status = ('ready to release' if result['ready'] else
                  'never observed' if not result['runs'] else
                  f"{RELEASE_PASSES - result['streak']} more pass(es)")
        rows.append({**marker, **result, 'status': status})
    return rows


def render(rows: list[dict]) -> str:
    header = ('UNIT', 'FILE', 'SINCE', 'RUNS', 'STREAK', 'LAST', 'STATUS', 'REPAIR')
    table = [header] + [((f"{r['owner']}.{r['name']}" if r.get('owner') else str(r['name'])),
                         f"{r['path']}:{r['line']}", str(r.get('since')), str(r['runs']),
                         f"{r['streak']}/{RELEASE_PASSES}", r['last'] or '-', r['status'], str(r.get('repair')))
                        for r in rows]
    widths = [max(len(row[i]) for row in table) for i in range(len(header))]
    lines = ['  '.join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip() for row in table]
    ready = sum(1 for r in rows if r['ready'])
    lines.append(f'{len(rows)} quarantined test(s); {ready} ready to release (remove the marker in the next deploy)')
    return '\n'.join(lines) + '\n'


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['report', 'link-repair'])
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--occurrence', help='link-repair: the FLAKY occurrence id named pending-handoff:<id>')
    parser.add_argument('--repair', help='link-repair: the dispatched boxes.dev repair thread URL')
    parser.add_argument('--ledger', type=Path, action='append',
                        help=f'factory event ledger(s); default {LEDGER} and {LOCAL_EVENTS}')
    parser.add_argument('--attempts', type=Path, action='append',
                        help='deploy cycle attempts dir(s); default <state dir>/attempts')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    root = args.root.resolve()
    if args.action == 'link-repair':
        if not args.occurrence or not args.repair:
            parser.error('link-repair requires --occurrence and --repair')
        try:
            edited = link_repair(root, args.occurrence, args.repair)
        except ValueError as error:
            print(f'link-repair refused: {error}', file=sys.stderr)
            return 1
        print('\n'.join(f'linked {path}: pending-handoff:{args.occurrence} -> {args.repair}' for path in edited))
        return 0
    ledgers = args.ledger or [root / LEDGER, root / LOCAL_EVENTS]
    attempts = args.attempts or [state_dir(root) / 'attempts']
    rows = report(root, ledgers, [a for a in attempts if a.is_dir()])
    print(json.dumps(rows, indent=2) if args.json else render(rows), end='' if not args.json else '\n')
    return 0
