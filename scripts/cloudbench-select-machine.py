#!/usr/bin/env python3
"""Select the named persistent Fly machine without trusting stale clone state."""

from __future__ import annotations

import json
import sys


def select_machine_id(machines: list[dict], name: str, stored_id: str) -> str:
    named = [
        machine
        for machine in machines
        if machine.get("id") and str(machine.get("name") or "") == name
    ]
    if len(named) != 1:
        return ""
    if stored_id:
        stored_named = next(
            (machine for machine in named if str(machine.get("id")) == stored_id), None
        )
        if stored_named:
            return stored_id
    return str(named[0]["id"])


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: cloudbench-select-machine.py NAME STORED_ID", file=sys.stderr)
        return 2
    try:
        machines = json.load(sys.stdin) or []
    except (json.JSONDecodeError, TypeError):
        machines = []
    print(select_machine_id(machines, sys.argv[1], sys.argv[2]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
