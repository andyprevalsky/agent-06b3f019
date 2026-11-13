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
import hashlib
import ast
from datetime import datetime, timezone
import importlib.util
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


# --- progress rows -------------------------------------------------------------------------

def deploy_selection_omissions(root: Path, before: dict, after: dict) -> dict[str, str]:
    """Omit only catalog-excluded native smoke cases during source refresh.

    This grants no execution or cleanup credit. Ordinary failure quarantines
    still run and cannot authorize removal from the deploy selection.
    """
    removed = set(before['checks']) - set(after['checks'])
    if not removed:
        return {}
    if any(gate.get('category') != 'smoke' or gate.get('native_cloud') is not True
           for gate in (before, after)):
        raise ValueError('repair cannot silently remove originally selected checks')
    rows = json.loads((root / CATALOG).read_text())
    if not isinstance(rows, list):
        raise ValueError('deploy quarantine catalog must be an array')
    reasons = {}
    for row in rows:
        if not isinstance(row, dict) or row.get('name') not in removed:
            continue
        name, reason = row['name'], row.get('deploy_quarantine')
        if name in reasons or not isinstance(reason, str) or not reason.strip():
            raise ValueError('removed deploy check lacks an unambiguous exclusion reason')
        reasons[name] = reason
    if set(reasons) != removed:
        raise ValueError('repair cannot silently remove originally selected checks')
    return reasons


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


def _suite_attribution_markers(occurrence: dict, entry: dict, root: Path, path: str) -> tuple[list[dict], dict]:
    """Attribution-only: recover all original unittest failures from a sealed native aggregate.

    Never used by unit_matches/streak. No suite-level execution or cleanup credit.
    """
    import hashlib

    def require(ok, message):
        if not ok:
            raise ValueError('suite attribution: ' + message)

    def pinned(rel, expected):
        require(isinstance(rel, str) and not Path(rel).is_absolute() and '..' not in Path(rel).parts,
                'unsafe proof path')
        target = root / rel
        require(target.resolve().is_relative_to(root.resolve()), 'proof escapes root')
        raw = target.read_bytes()
        require(isinstance(expected, str) and hashlib.sha256(raw).hexdigest() == expected, 'proof hash changed')
        return raw

    binding = entry.get('suite_binding')
    require(isinstance(binding, dict), 'native suite binding required')
    require(occurrence.get('gate') == 'deploy-command-structural' and occurrence.get('native_result') == 'FLAKY'
            and occurrence.get('attempts') == 2, 'not a structural single-rerun occurrence')
    unit = occurrence['unit']
    require(re.fullmatch(r'[a-z0-9-]+', unit) is not None, 'invalid suite name')
    require(path == f'scripts/tests/{unit}.test.py', 'not the exact canonical suite path')
    receipt_rel = binding.get('receipt')
    expected_suffix = f"/attempts/{occurrence['round']}/{occurrence['phase']}/deploy-command-structural/receipt.json"
    require(isinstance(receipt_rel, str) and receipt_rel.startswith('.context/')
            and receipt_rel.endswith(expected_suffix), 'wrong original receipt location')
    receipt = json.loads(pinned(receipt_rel, binding.get('receipt_sha256')))
    require(receipt.get('source') == occurrence.get('source') and receipt.get('gate') == occurrence['gate']
            and receipt.get('executed') is True and receipt.get('complete') is True
            and type(receipt.get('native_exit')) is int and receipt['native_exit'] == 0
            and all(receipt.get(k) is False for k in ('timed_out', 'cancelled', 'lingering_group')),
            'original native receipt/source not complete')
    rows = [r for r in receipt.get('flaky', []) if r.get('unit') == unit]
    require(len(rows) == 1 and rows[0].get('status') == 'FLAKY' and rows[0].get('attempts') == 2
            and rows[0].get('scope') == 'suite' and rows[0].get('log') == occurrence.get('evidence')
            and rows[0].get('at') == occurrence.get('unit_finished_at'), 'original occurrence not in receipt')
    worker = receipt.get('worker_evidence', {}).get('deploy-command-structural', {})
    require(worker.get('command', [])[:2] == ['python3', 'scripts/run-deploy-structural-gates.py']
            and worker.get('native_exit') == 0 and type(worker.get('native_exit')) is int
            and worker.get('status') == 'PASS'
            and all(worker.get(k) is False for k in ('timed_out', 'cancelled', 'lingering_group'))
            and worker.get('flaky') == receipt.get('flaky'), 'worker provenance mismatch')
    log_path = Path(worker.get('log', ''))
    require(log_path.is_absolute() and log_path.is_relative_to((root / Path(receipt_rel).parent / 'remote-artifact').resolve()),
            'worker log outside original artifact')
    require(log_path.resolve().is_relative_to((root / Path(receipt_rel).parent / 'remote-artifact').resolve()),
            'resolved worker log outside original artifact')
    log_rel = str(log_path.relative_to(root.resolve()))
    text = pinned(log_rel, worker.get('sha256')).decode()
    require(binding.get('log_sha256') == worker.get('sha256'), 'unreviewed worker log')
    head = (occurrence.get('source') or {}).get('head', '')
    require(re.fullmatch(r'[0-9a-f]{40}', head) is not None, 'invalid original source')
    registry = subprocess.run(['git', '--no-replace-objects', 'show', f'{head}:scripts/run-deploy-structural-gates.py'], cwd=root,
                              check=True, capture_output=True, text=True).stdout
    tree = ast.parse(registry)
    gates = [node for node in tree.body if isinstance(node, ast.Assign)
             and any(isinstance(t, ast.Name) and t.id == 'GATES' for t in node.targets)]
    require(len(gates) == 1 and isinstance(gates[0].value, (ast.Tuple, ast.List)), 'canonical registry missing')
    commands = []
    for node in gates[0].value.elts:
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'Gate' and node.args:
            if isinstance(node.args[0], ast.Constant) and node.args[0].value == unit:
                commands.append(ast.literal_eval(node.args[1]))
    require(commands == [('python3', path)], 'original canonical command mismatch')
    starts = list(re.finditer(r'^== ' + re.escape(unit) + r': exit=0 duration=[0-9.]+s ==$', text, re.M))
    require(len(starts) == 1, 'ambiguous aggregate suite block')
    block = text[starts[0].end():]
    block = re.split(r'^== ', block, maxsplit=1, flags=re.M)[0]
    reruns = list(re.finditer(r'^--- rerun of ' + re.escape(unit)
                             + r' \(attempt 2 of 2: ([A-Za-z0-9_. ]+)\) ---$', block, re.M))
    require(len(reruns) == 1, 'missing exact case rerun boundary')
    first, second = block[:reruns[0].start()], block[reruns[0].end():]
    headers = re.findall(r'^(?:ERROR|FAIL): (test\w+) \(__main__\.([A-Za-z_]\w*)\.(test\w+)\)$', first, re.M)
    all_headers = re.findall(r'^(?:ERROR|FAIL):.*$', first, re.M)
    summaries = re.findall(r'^FAILED \(([^)]*)\)$', first, re.M)
    require(len(summaries) == 1 and len(headers) == len(all_headers) and headers, 'ambiguous failure headers')
    counts = {}
    for part in summaries[0].split(','):
        key, sep, value = part.strip().partition('=')
        require(sep and key in ('errors', 'failures') and key not in counts and value.isdigit(), 'unknown failure summary')
        counts[key] = int(value)
    ids = [f'{owner}.{name}' for name, owner, method in headers if name == method]
    require(len(ids) == len(headers) == sum(counts.values()) and len(set(ids)) == len(ids), 'incomplete failure coverage')
    require(reruns[0].group(1).split() == ids, 'rerun does not cover all original failures')
    require(re.fullmatch(r'\s*[.]+\s*\n-+\nRan ' + str(len(ids))
                         + r' tests? in [0-9.]+s\n\nOK\s*', second) is not None, 'rerun not clean/exact')
    available = markers(root, [path])
    found = []
    for case in ids:
        owner, name = case.split('.')
        matches = [m for m in available if m.get('owner') == owner and m['name'] == name]
        require(len(matches) == 1, 'every original failed case needs exactly one marker: ' + case)
        require(matches[0].get('evidence') == entry['evidence'], 'case marker evidence differs from attribution')
        found.extend(matches)
    return found, {**binding, 'cases': ids, 'command': ['python3', path], 'source': occurrence['source']}


# unittest's own failure header (3.11): "FAIL: test_x (module.Class.test_x)".
_UNITTEST_FAILURE = re.compile(r'^(?:FAIL|ERROR): \S+ \(([^()\s]+)\)', re.M)


def failed_unittest_names(occurrence: dict) -> list[str]:
    """Exact unittest ids a suite-level FLAKY unit printed for its failed first attempt.

    The structural runner names a FLAKY unit after its whole suite job, while a quarantine marker
    sits on one test method; the occurrence's own failure output is what ties the two together.
    """
    return _UNITTEST_FAILURE.findall(str(occurrence.get('detail') or ''))


def named_test_matches(marker: dict, test_id: str, path: str, occurrence: dict) -> bool:
    """A failed unittest id names this marker: same module (file), class and method.

    A script-run suite reports its module as `__main__`; then the marker file must be that suite's own
    file (its stem is the FLAKY unit) or the failing method's traceback frame must be in that file.
    """
    owner, name = marker.get('owner'), marker.get('name')
    if not name or test_id.rsplit('.', 1)[-1] != name:
        return False
    parts = test_id.split('.')
    if owner and (len(parts) < 3 or parts[-2] != owner):
        return False
    module = '.'.join(parts[:-2] if owner else parts[:-1])
    stem = Path(path).name.removesuffix('.py').removesuffix('.test')
    if module == '__main__':
        suite = str(occurrence.get('unit') or '').split('[', 1)[0]
        frame = re.search(r'File "[^"]*/' + re.escape(path) + r'", line \d+, in ' + re.escape(name) + r'\b',
                          str(occurrence.get('detail') or ''))
        return stem == suite or frame is not None
    return Path(path).with_suffix('').as_posix().replace('/', '.').endswith(module)


def native_case_binding(occurrence: dict, entry: dict, root: Path) -> tuple[dict, dict, dict]:
    """Bind an explicit RCA definition to its original canonical native receipt and log."""
    def need(ok, reason):
        if not ok:
            raise ValueError('native definition binding: ' + reason)

    def raw(path):
        need(path.is_file() and path.stat().st_size <= 64 * 1024 * 1024, 'missing or oversized native evidence')
        return path.read_bytes()

    def sha(value):
        return hashlib.sha256(value).hexdigest()

    def document(path):
        value = json.loads(raw(path))
        need(isinstance(value, dict), 'native document must be an object')
        return value

    try:
        saved = entry.get('native_binding')
        need(not (saved and entry.get('native_case')), 'ambiguous binding request')
        selected = saved if saved else entry.get('native_case')
        need(isinstance(selected, dict), 'explicit native case required')
        if not saved:
            need(set(selected) == {'definition', 'error', 'log_sha256'}, 'native case fields')
        definition, error = selected['definition'], selected['error']
        need(isinstance(definition, str) and re.fullmatch(r'[A-Za-z0-9_./-]+\.py::(?:[A-Za-z_]\w*::)?[A-Za-z_]\w*', definition), 'definition syntax')
        parts = definition.split('::')
        relative = Path(parts[0])
        need(not relative.is_absolute() and '..' not in relative.parts and str(relative) == parts[0]
             and entry.get('marker') == parts[0], 'definition and marker path')
        need(type(occurrence.get('round')) is int and occurrence['round'] > 0, 'original round')
        need(all(isinstance(occurrence.get(k), str) and re.fullmatch(r'[A-Za-z0-9_-]+', occurrence[k])
                 for k in ('phase', 'gate')), 'original phase/gate')
        folder = state_dir(root) / 'attempts' / str(occurrence['round']) / occurrence['phase'] / occurrence['gate']
        need(folder.resolve().is_relative_to(root.resolve()), 'canonical receipt path')
        receipt, request, worker = (document(folder / n) for n in ('receipt.json', 'request.json', 'result.json'))
        need(all(d.get('source') == occurrence['source'] and d.get('gate') == occurrence['gate']
                 and d.get('token') == receipt.get('token') for d in (receipt, request, worker))
             and isinstance(receipt.get('token'), str) and bool(receipt['token']), 'source/gate/token mismatch')
        need(receipt.get('complete') is True and receipt.get('executed') is True
             and receipt.get('native_exit') == 0 and worker.get('complete') is True
             and request.get('phase') == occurrence['phase'], 'original completed native receipt')
        for result in (receipt, worker):
            need(('source_unchanged' not in result or result['source_unchanged'] is True)
                 and ('interrupted' not in result or result['interrupted'] is False)
                 and ('cleanup_complete' not in result or result['cleanup_complete'] is True)
                 and ('native_exit' not in result or type(result['native_exit']) is int
                      and result['native_exit'] == 0), 'contradictory native worker state')
        need(receipt.get('worker_result') == str(folder / 'result.json'), 'canonical worker result')
        need(isinstance(receipt.get('flaky'), list) and all(isinstance(r, dict) for r in receipt['flaky']),
             'native flaky rows')
        rows = [r for r in receipt['flaky'] if r.get('unit') == occurrence['unit']]
        need(len(rows) == 1 and rows[0].get('status') == 'FLAKY' and rows[0].get('attempts') == 2
             and rows[0].get('log') == occurrence.get('evidence')
             and rows[0].get('at') == occurrence.get('unit_finished_at'), 'original flaky unit/log identity')
        worker_root = request.get('worker_root')
        need(isinstance(worker_root, str) and Path(worker_root).is_absolute()
             and worker.get('worker_root') == worker_root, 'worker root')
        remote = worker.get('remote') or {}
        need(isinstance(remote, dict), 'native remote envelope')
        need(remote.get('transport') == 'github-actions' and remote.get('event_sha') == occurrence['source']['head'],
             'verified remote source')
        files = folder / 'remote-artifact' / 'files'

        def localized(original):
            need(isinstance(original, str) and str(Path(original)) == original, 'native artifact path')
            rel = Path(original).relative_to(worker_root)
            need('..' not in rel.parts, 'artifact traversal')
            path = files / rel
            need(path.resolve().is_relative_to(files.resolve()), 'localized artifact escape')
            return path, str(rel)

        log, log_relative = localized(rows[0]['log'])
        need(isinstance(worker.get('evidence'), dict), 'native evidence envelope')
        evidence = worker['evidence'][occurrence['gate']]
        need(isinstance(evidence, dict), 'native gate evidence')
        output, output_relative = localized(evidence['remote_log'])
        need(evidence.get('log') == str(output) and evidence.get('status') == 'PASS'
             and evidence.get('native_exit') == 0, 'localized worker output')
        output_raw, log_raw = raw(output), raw(log)
        need(sha(output_raw) == evidence.get('sha256'), 'worker output hash')
        need(log_raw and log_raw in output_raw and sha(log_raw) == selected['log_sha256'], 'unbound first-attempt log/hash')
        text = re.sub(r'\x1b\[[0-9;]*m', '', log_raw.decode('utf-8'))
        failures = set(re.findall(r'^FAILED ([^\s]+) - (.+)$', text, re.M))
        summaries = set(re.findall(r'^(\d+ failed(?:, [^\n]+)?) in [\d.]+s$', text, re.M))
        need(failures == {(definition, error)} and bool(summaries)
             and all(re.fullmatch(r'1 failed(?:, \d+ passed)?(?:, \d+ warnings?)?', row) for row in summaries)
             and not re.search(r'^ERROR(?:\s|$)|^!+ Interrupted:', text, re.M),
             'requires exactly one actual failed pytest definition and no other pytest errors')
        packet = entry.get('post_merge') or {}
        need(isinstance(packet, dict), 'native RCA packet')
        need(packet.get('test') == definition and packet.get('error') == error
             and packet.get('source') == occurrence['source'], 'RCA packet definition/error/source')
        proof = {'kind':'nested-pytest-v1', 'source':occurrence['source'], 'gate':occurrence['gate'],
                 'round':occurrence['round'], 'phase':occurrence['phase'], 'unit':occurrence['unit'],
                 'token':receipt['token'], 'worker_root':worker_root, 'definition':definition, 'error':error,
                 'log_relative':log_relative, 'log_sha256':sha(log_raw),
                 'output_relative':output_relative, 'output_sha256':sha(output_raw),
                 'receipt_sha256':sha(raw(folder/'receipt.json')), 'request_sha256':sha(raw(folder/'request.json')),
                 'worker_result_sha256':sha(raw(folder/'result.json'))}
        need(not saved or saved == proof, 'retained binding changed')
        return proof, receipt, request
    except (OSError, KeyError, TypeError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('native definition binding: invalid or missing native evidence') from exc


def _native_lineage(state: dict | None, occurrence: dict, receipt: dict, request: dict, *, retained: bool) -> None:
    """Verify the original recorded attempt; a refreshed current plan may differ."""
    def need(ok):
        if not ok:
            raise ValueError('native definition binding: original recorded receipt/plan mismatch')

    need(isinstance(state, dict))
    attempts = state.get('attempts')
    need(isinstance(attempts, list) and all(isinstance(a, dict) for a in attempts))
    need(all(isinstance(a.get('results'), list)
             and all(isinstance(r, dict) for r in a['results']) for a in attempts))
    recorded = [r for a in attempts
                if a.get('source') == occurrence['source'] and a.get('phase') == occurrence['phase']
                for r in a['results'] if r.get('gate') == occurrence['gate']
                and r.get('token') == receipt['token']]
    need(len(recorded) == 1 and recorded[0] == receipt)
    if not retained:
        plan = state.get('plan')
        need(isinstance(plan, dict) and isinstance(plan.get('gates'), list)
             and all(isinstance(g, dict) for g in plan['gates']))
        gates = [g for g in plan['gates'] if g.get('name') == occurrence['gate']]
        need(len(gates) == 1 and gates[0].get('worker_root') == request.get('worker_root'))


def validate_attribution(occurrence: dict, entry: dict, root: Path, *, state: dict | None = None) -> dict:
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
    binding = None
    suite_binding = None
    if entry.get('native_case') is not None or entry.get('native_binding') is not None:
        if 'suite_binding' in entry:
            raise ValueError('native case binding and suite binding are exclusive')
        binding, _receipt, _request = native_case_binding(occurrence, entry, root)
        _native_lineage(state, occurrence, _receipt, _request, retained=bool(entry.get('native_binding')))
        parts = binding['definition'].split('::')
        found = [m for m in markers(root, [path]) if m['name'] == parts[-1]
                 and m.get('owner') == (parts[-2] if len(parts) == 3 else None)
                 and m['error'] == binding['error'] and m['evidence'] == entry['evidence']]
    else:
        found = [m for m in markers(root, [path]) if unit_matches(m, occurrence['unit'])]
        if not found and entry.get('case') is not None and 'suite_binding' not in entry:
            found = _domain_case_markers(occurrence, entry['case'], root, path)
        named = failed_unittest_names(occurrence)
        if not found and named and 'suite_binding' not in entry:
            # A suite-level unit is attributed only when EVERY failed test it names carries a marker here.
            candidates = markers(root, [path])
            matched = [[m for m in candidates if named_test_matches(m, test_id, path, occurrence)] for test_id in named]
            found = [m for group in matched for m in group] if all(matched) else []
        packet_test = str((entry.get('post_merge') or {}).get('test') or '') if isinstance(entry.get('post_merge'), dict) else ''
        if not found and not named and packet_test and 'suite_binding' not in entry:
            # The recorded detail keeps only the failure's tail, so unittest's header can be cut off
            # (PR #1925). Bind the packet's test only when the surviving traceback frame is that method
            # in this marker file.
            name = packet_test.rsplit('.', 1)[-1]
            frame = re.search(r'File "[^"]*/' + re.escape(path) + r'", line \d+, in ' + re.escape(name) + r'\b',
                              str(occurrence.get('detail') or ''))
            found = [m for m in markers(root, [path]) if frame is not None
                     and named_test_matches(m, '__main__.' + packet_test, path, occurrence)]
    if not found and 'suite_binding' not in entry:
        raise ValueError(f"no quarantine marker for {occurrence['unit']} in {path}")
    if not found:
        found, suite_binding = _suite_attribution_markers(occurrence, entry, root, path)
    elif entry.get('suite_binding'):
        raise ValueError('direct-case attribution must not carry suite binding')
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
    if any(m['repair'] not in (expected, f"pending-handoff:{occurrence['id']}") for m in found):
        raise ValueError(f"the marker's repair must be {expected} until the post-merge dispatch is linked")
    # The attribution travels with the handoff: the dispatched /goal carries the /RCA gate and evidence.
    packet = {**packet, 'attribution': 'NOT_INTRODUCED', 'rca': entry['evidence'], 'occurrence': occurrence['id'],
              'unit': occurrence['unit'], 'gate': occurrence.get('gate'), 'marker': path}
    if suite_binding is not None:
        packet['suite_binding'] = suite_binding
    # The recorded attribution keeps its case label: merge revalidates it with attribution_block().
    return {'attribution': attribution, 'evidence': entry['evidence'], 'marker': path, 'post_merge': packet,
            **({'native_binding': binding} if binding else {}),
            **({'suite_binding': suite_binding} if suite_binding is not None else {}),
            **({'case': entry['case']} if entry.get('case') is not None else {})}


_DOMAIN_SINGLE_FAILURE = re.compile(r'\(\d+ passed, 1 failed; 1 failed case\(s\): ([A-Za-z_]\w*); first error: ')


def _domain_case_markers(occurrence: dict, case: object, root: Path, path: str) -> list[dict]:
    """The marker for one recorded case of a blackbox-domain FLAKY unit (e.g. `rose-browser-use`).

    A domain unit names no test function, so the attribution names the recorded case label. It binds
    only when the flaky first attempt failed exactly that one case and the marker file records that
    label with exactly one function that carries the quarantine marker.
    """
    if not isinstance(case, str) or not re.fullmatch(r'[A-Za-z_]\w*', case):
        raise ValueError('case must be the recorded blackbox case label')
    failed = _DOMAIN_SINGLE_FAILURE.findall(str(occurrence.get('detail') or ''))
    if failed != [case]:
        raise ValueError(f"case {case} is not the single failed case of FLAKY unit {occurrence['unit']}")
    try:
        text = (root / path).read_text(errors='replace')
    except OSError:
        return []
    functions = set(re.findall(r'\brecord(?:_async)?\(\s*([\'"])' + re.escape(case) + r'\1\s*,\s*([A-Za-z_]\w*)\s*\)',
                               text))
    names = {name for _quote, name in functions}
    if len(names) != 1:
        raise ValueError(f'{path} must record case {case} with exactly one test function')
    return [m for m in markers(root, [path]) if m['name'] in names and m.get('owner') is None]


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


def attribution_block(flaky_occurrences: list[dict], root: Path | None = None, *, state: dict | None = None) -> str | None:
    """Merge refusal while any FLAKY unit lacks a recorded attribution; with root, it must still hold there."""
    missing = [f for f in flaky_occurrences if not f.get('attribution')]
    if missing:
        names = ', '.join(f"{f['gate']} :: {f['unit']}" for f in missing[:5])
        return (f'{len(missing)} FLAKY unit(s) lack /RCA attribution ({names}); record it with '
                'deploy_test_cycle.py attribute-flaky')
    for occurrence in flaky_occurrences if root is not None else []:
        try:
            validate_attribution(occurrence, occurrence['attribution'], root, state=state)
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
