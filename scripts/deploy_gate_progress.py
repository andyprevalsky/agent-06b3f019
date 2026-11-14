"""Live per-test progress for deploy gates: the DEPLOY_GATE_PROGRESS protocol.

A gate's worker gives every test runner it starts a progress file. Runners append one JSON
line per finished unit (domain, suite, file or test); the worker appends one per case. On a
Blacksmith VM, remote-run streams the file over the R2 result channel, the coordinator's
launcher mirrors it into the cycle's attempt folder, and the deploy cycle reports the first
failed unit while the gate is still running.

    runner ──append──┐
    worker ──append──┴─> progress.jsonl ──(VM: remote-run puts it to R2)──> coordinator launcher
                                                                             │ mirror
    deploy cycle <──scan── <attempt>/<gate>/progress.jsonl <──────────────────┘
        └─> DEPLOY_GATE_EARLY_FAILURE line + /RCA dispatch (the final result reuses its id)

Row (v1), one JSON object per line:
    {"v": 1, "scope": "case"|"domain"|"suite"|"file"|"test", "case": <DEPLOY_GATE_CASE or "">,
     "unit": <name>, "status": <STATUSES>, "at": <epoch seconds>,
     "detail": <at most 2000 chars>, "log": <path or "">,
     "quarantine": {"since", "repair", "error", "evidence"}   # QUARANTINED_* rows only
     "attempts": <int >= 2>}                                   # FLAKY rows only (optional)

Blocking statuses are FAIL and UNVERIFIED (failures()). QUARANTINED_FAIL / QUARANTINED_PASS
come from a test carrying the in-definition @quarantine marker (scripts/lib/test_quarantine.py):
it ran, and its result never blocks. FLAKY means the runner's single rerun of a failed unit
passed; the gate passes but the unit still needs /RCA attribution. The optional keys are
appended after the original eight, so a v1 reader that ignores unknown keys is unaffected.

Progress is advisory. The gate's exit code and result.json stay the verdict; a progress row
only lets diagnosis start earlier. Writers append each row with one O_APPEND write and never
raise, so a broken progress file cannot fail a test run.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

ENV = 'DEPLOY_GATE_PROGRESS'
CASE_ENV = 'DEPLOY_GATE_CASE'
VERSION = 1
STATUSES = ('PASS', 'FAIL', 'UNVERIFIED', 'QUARANTINED_FAIL', 'QUARANTINED_PASS', 'FLAKY')
BLOCKING = ('FAIL', 'UNVERIFIED')
QUARANTINED = ('QUARANTINED_FAIL', 'QUARANTINED_PASS')
FLAKY = 'FLAKY'
QUARANTINE_KEYS = ('since', 'repair', 'error', 'evidence')
SCOPES = ('case', 'domain', 'suite', 'file', 'test')
DETAIL_LIMIT = 2000


def quarantine_valid(value: object) -> bool:
    return (isinstance(value, dict) and set(value) == set(QUARANTINE_KEYS)
            and all(isinstance(value[key], str) and value[key] for key in QUARANTINE_KEYS))


def row(unit: str, status: str, *, scope: str = 'test', detail: str = '', log: str = '',
        case: str | None = None, at: float | None = None, quarantine: dict | None = None,
        attempts: int | None = None) -> dict:
    if status not in STATUSES:
        raise ValueError(f'progress status must be one of {STATUSES}')
    if scope not in SCOPES:
        raise ValueError(f'progress scope must be one of {SCOPES}')
    if (status in QUARANTINED) != (quarantine is not None):
        raise ValueError('quarantine metadata belongs on QUARANTINED_* rows only, and they require it')
    if quarantine is not None and not quarantine_valid(quarantine):
        raise ValueError(f'quarantine metadata needs exactly the non-empty string keys {QUARANTINE_KEYS}')
    if attempts is not None and (status != FLAKY or isinstance(attempts, bool)
                                 or not isinstance(attempts, int) or attempts < 2):
        raise ValueError('attempts belongs on FLAKY rows only and must be an integer >= 2')
    value = {'v': VERSION, 'scope': scope, 'case': os.environ.get(CASE_ENV, '') if case is None else case,
             'unit': str(unit), 'status': status, 'at': time.time() if at is None else at,
             'detail': str(detail)[-DETAIL_LIMIT:], 'log': str(log or '')}
    if quarantine is not None:
        value['quarantine'] = {key: quarantine[key] for key in QUARANTINE_KEYS}
    if attempts is not None:
        value['attempts'] = attempts
    return value


def serialize(value: dict) -> bytes:
    return (json.dumps(value, separators=(',', ':')) + '\n').encode()


def report(unit: str, status: str, *, scope: str = 'test', detail: str = '', log: str = '',
           case: str | None = None, path: str | os.PathLike | None = None,
           quarantine: dict | None = None, attempts: int | None = None) -> bool:
    """Append one row to the gate's progress file. Returns False when there is none or it is unwritable."""
    target = path or os.environ.get(ENV)
    if not target:
        return False
    data = serialize(row(unit, status, scope=scope, detail=detail, log=log, case=case,
                         quarantine=quarantine, attempts=attempts))
    try:
        fd = os.open(target, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
    except OSError:
        return False
    return True


def valid(value: object) -> bool:
    if not (isinstance(value, dict) and value.get('v') == VERSION and value.get('status') in STATUSES
            and value.get('scope') in SCOPES and isinstance(value.get('unit'), str) and value['unit']
            and isinstance(value.get('case', ''), str) and isinstance(value.get('at'), (int, float))):
        return False
    if value['status'] in QUARANTINED:
        return quarantine_valid(value.get('quarantine'))
    if 'quarantine' in value:
        return False
    attempts = value.get('attempts')
    if attempts is None:
        return True
    return value['status'] == FLAKY and isinstance(attempts, int) and not isinstance(attempts, bool) and attempts >= 2


def parse(chunk: bytes) -> list[dict]:
    rows = []
    for line in chunk.splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue  # a malformed line never hides the rows around it
        if valid(value):
            rows.append(value)
    return rows


def read_new(path: str | os.PathLike, offset: int = 0) -> tuple[list[dict], int]:
    """Complete rows appended since offset, and the new offset. A partial last line waits for its newline."""
    try:
        with open(path, 'rb') as stream:
            stream.seek(offset)
            chunk = stream.read()
    except FileNotFoundError:
        return [], offset
    end = chunk.rfind(b'\n')
    if end < 0:
        return [], offset
    return parse(chunk[:end + 1]), offset + end + 1


def failures(rows: list[dict]) -> list[dict]:
    """Blocking rows only: FAIL and UNVERIFIED. Quarantined and flaky units never block here."""
    return [r for r in rows if r['status'] in BLOCKING]


def quarantined(rows: list[dict]) -> list[dict]:
    return [r for r in rows if r['status'] in QUARANTINED]


def flaky(rows: list[dict]) -> list[dict]:
    return [r for r in rows if r['status'] == FLAKY]


def stdout_line(value: dict) -> str | None:
    """The one log line a QUARANTINED_* or FLAKY row is also printed as; None for other rows."""
    if value['status'] in QUARANTINED:
        meta = value['quarantine']
        return (f"TEST_QUARANTINE status={value['status']} unit={value['unit']} "
                f"since={meta['since']} repair={meta['repair']}")
    if value['status'] == FLAKY:
        return f"TEST_FLAKY unit={value['unit']} attempts={value.get('attempts', 2)} attribution=REQUIRED"
    return None


def describe(gate: str, failure: dict, *, check: str | None = None, occurrence: str | None = None,
             request: str | None = None) -> str:
    """The one-line notice the cycle prints once per opened early occurrence (one per failing check)."""
    unit = failure['unit']
    case = failure.get('case') or ''
    # Single-case gates name their only case after the gate itself; repeating it adds nothing.
    where = unit if case in ('', unit, gate) else f'{case} :: {unit}'
    line = f"DEPLOY_GATE_EARLY_FAILURE gate={gate} {failure['scope']}={where} status={failure['status']}"
    if check is not None:
        line += f' check={check}'
    if occurrence is not None:
        line += f' id={occurrence}'
    if request is not None:
        line += f' rca={request}'
    return line


def ensure_parent(path: str | os.PathLike) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target
