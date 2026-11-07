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
     "unit": <name>, "status": "PASS"|"FAIL"|"UNVERIFIED", "at": <epoch seconds>,
     "detail": <at most 2000 chars>, "log": <path or "">}

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
STATUSES = ('PASS', 'FAIL', 'UNVERIFIED')
SCOPES = ('case', 'domain', 'suite', 'file', 'test')
DETAIL_LIMIT = 2000


def row(unit: str, status: str, *, scope: str = 'test', detail: str = '', log: str = '',
        case: str | None = None, at: float | None = None) -> dict:
    if status not in STATUSES:
        raise ValueError(f'progress status must be one of {STATUSES}')
    if scope not in SCOPES:
        raise ValueError(f'progress scope must be one of {SCOPES}')
    return {'v': VERSION, 'scope': scope, 'case': os.environ.get(CASE_ENV, '') if case is None else case,
            'unit': str(unit), 'status': status, 'at': time.time() if at is None else at,
            'detail': str(detail)[-DETAIL_LIMIT:], 'log': str(log or '')}


def report(unit: str, status: str, *, scope: str = 'test', detail: str = '', log: str = '',
           case: str | None = None, path: str | os.PathLike | None = None) -> bool:
    """Append one row to the gate's progress file. Returns False when there is none or it is unwritable."""
    target = path or os.environ.get(ENV)
    if not target:
        return False
    data = (json.dumps(row(unit, status, scope=scope, detail=detail, log=log, case=case),
                       separators=(',', ':')) + '\n').encode()
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
    return (isinstance(value, dict) and value.get('v') == VERSION and value.get('status') in STATUSES
            and value.get('scope') in SCOPES and isinstance(value.get('unit'), str) and value['unit']
            and isinstance(value.get('case', ''), str) and isinstance(value.get('at'), (int, float)))


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
    return [r for r in rows if r['status'] != 'PASS']


def describe(gate: str, failure: dict) -> str:
    """The one-line early-failure notice the cycle prints for the deploy agent."""
    unit = failure['unit']
    case = failure.get('case') or ''
    # Single-case gates name their only case after the gate itself; repeating it adds nothing.
    where = unit if case in ('', unit, gate) else f'{case} :: {unit}'
    return f"DEPLOY_GATE_EARLY_FAILURE gate={gate} {failure['scope']}={where} status={failure['status']}"


def ensure_parent(path: str | os.PathLike) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target
