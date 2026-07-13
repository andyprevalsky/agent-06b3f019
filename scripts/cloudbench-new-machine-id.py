#!/usr/bin/env python3
"""Select exactly one newly-created Fly machine from before/after JSON lists."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def select_new_machine_id(
    before: list[dict], after: list[dict], source_id: str, expected_name: str = ""
) -> str:
    before_ids = {str(machine.get("id")) for machine in before if machine.get("id")}
    new_ids = [
        str(machine.get("id"))
        for machine in after
        if machine.get("id")
        and str(machine.get("id")) not in before_ids
        and str(machine.get("id")) != source_id
        and (not expected_name or str(machine.get("name") or "") == expected_name)
    ]
    return new_ids[0] if len(new_ids) == 1 else ""


def main() -> int:
    if len(sys.argv) != 5:
        print(
            "usage: cloudbench-new-machine-id.py BEFORE AFTER SOURCE_ID EXPECTED_NAME",
            file=sys.stderr,
        )
        return 2
    try:
        before = json.loads(Path(sys.argv[1]).read_text()) or []
        after = json.loads(Path(sys.argv[2]).read_text()) or []
    except (OSError, json.JSONDecodeError, TypeError):
        return 1
    machine_id = select_new_machine_id(before, after, sys.argv[3], sys.argv[4])
    if not machine_id:
        return 1
    print(machine_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
