#!/usr/bin/env python3
"""Test quarantine: markers in the test definitions, FLAKY attribution and release streaks.

A quarantined test carries its marker in its own definition (Python
``@quarantine(since=, repair=, error=, evidence=)`` from scripts/lib/test_quarantine.py,
TypeScript ``quarantine(meta, fn)``). It still runs; its rows are QUARANTINED_FAIL or
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
LOCAL_EVENTS = Path('.context/factory-events.jsonl')
STATE_DIR_ENV = 'DEPLOY_TEST_CYCLE_STATE_DIR'
DEFAULT_STATE_DIR = Path('.context/deploy-pipeline')
# Line order in bounded ledger detail: a failing test name is never the one dropped.
PRIORITY = {'FAIL': 0, 'UNVERIFIED': 0, FLAKY: 1, QUARANTINED_FAIL: 2, QUARANTINED_PASS: 3}
SCAN_EXCLUDE = ('claude-code-src/', 'openclaw/', 'hermes-agent/', 'codex/', 'prime-agent/', 'kimi-code/',
                'node_modules/', 'scripts/lib/test_quarantine.py')
BOXES_THREAD = re.compile(r'https://boxes\.dev/thread/[A-Za-z0-9_-]+')


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
    NOT_INTRODUCED: the unit's quarantine marker is in the tree with the repair link of its handoff
    (repair_agent), or the existing post-merge packet is recorded (post_merge). UNKNOWN blocks.
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
    link, packet = entry.get('repair_agent'), entry.get('post_merge')
    if bool(link) == bool(packet):
        raise ValueError('NOT_INTRODUCED records exactly one handoff: repair_agent or post_merge')
    if link and (not BOXES_THREAD.fullmatch(link) or link != found[0]['repair']):
        raise ValueError("repair_agent must be the boxes.dev repair thread named in the marker's repair")
    if packet and (not isinstance(packet, dict)
                   or any(not packet.get(k) for k in ('test', 'command', 'scope', 'error', 'source', 'evidence'))):
        raise ValueError('a post-merge packet requires test, command, scope, error, source and evidence')
    out = {'attribution': attribution, 'evidence': entry['evidence'], 'marker': path}
    out.update({'repair_agent': link} if link else {'post_merge': packet})
    return out


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


def safe_line(text: str) -> str:
    """One bounded, secret-free ledger line: unsafe characters replaced, opaque tokens redacted."""
    text = _UNSAFE.sub('?', ' '.join(str(text).split()))
    return _OPAQUE.sub('<redacted>', text)[:LINE_LIMIT]


def ledger_line(gate: str, row: dict) -> str:
    return safe_line(f"{row['status']} {gate}::{row['unit']} at={int(row.get('at') or 0)}")


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


def state_dir(root: Path) -> Path:
    value = Path(os.environ.get(STATE_DIR_ENV) or DEFAULT_STATE_DIR)
    return value if value.is_absolute() else root / value


# --- markers -------------------------------------------------------------------------------

def _files(root: Path, paths: list[str] | None) -> list[str]:
    if paths is not None:
        return paths
    listed = subprocess.run(['git', 'ls-files', '-co', '--exclude-standard', '--', '*.py', '*.ts', '*.tsx'],
                            cwd=root, capture_output=True, text=True)
    return [p for p in listed.stdout.splitlines() if not p.startswith(SCAN_EXCLUDE)]


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
        if 'quarantine(' not in text:
            continue
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
               for candidate in (unit, base, safe_line(unit))
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
            seen[(safe_line(obs['unit']), int(obs['at']), obs['status'])] = obs  # ledger + local copy count once
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
    parser.add_argument('action', choices=['report'])
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--ledger', type=Path, action='append',
                        help=f'factory event ledger(s); default {LEDGER} and {LOCAL_EVENTS}')
    parser.add_argument('--attempts', type=Path, action='append',
                        help='deploy cycle attempts dir(s); default <state dir>/attempts')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    root = args.root.resolve()
    ledgers = args.ledger or [root / LEDGER, root / LOCAL_EVENTS]
    attempts = args.attempts or [state_dir(root) / 'attempts']
    rows = report(root, ledgers, [a for a in attempts if a.is_dir()])
    print(json.dumps(rows, indent=2) if args.json else render(rows), end='' if not args.json else '\n')
    return 0
