#!/usr/bin/env python3
"""Network-free synthetic business service for Process Bench code sandboxes.

Deliberately does not enforce prerequisites or choose actions for the agent.
Each call persists the submitted business input and returns a fixture result.
The benchmark judges the original native tool transcript, never this output
directory alone. This file is an input fixture and must not be modified.
"""

import hashlib
import json
import sys
from pathlib import Path


def execute(case, action, actor, entity, day, input_json, expected_hash, *, fixture_path=None, output_dir=None):
    fixture_path = fixture_path or Path(__file__).with_name("process-fixtures.json")
    raw = fixture_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_hash:
        raise ValueError("fixture fingerprint does not match")
    data = json.loads(input_json)
    if not isinstance(data, dict) or not actor or not entity or int(day) < 0:
        raise ValueError("invalid business action input")
    fixtures = json.loads(raw)
    result = fixtures[case][action]
    receipt = dict(process_receipt=1, case=case, action=action, actor=actor,
                   entity=entity, day=int(day), input=data, output=result)
    output_dir = output_dir or Path("/home/user/output/process-artifacts")
    output_dir.mkdir(parents=True, exist_ok=True)
    # Append: repeated/mistaken actions stay visible, never rewrite history.
    path = output_dir / f"{case}.jsonl"
    with path.open("a") as handle:
        handle.write(json.dumps(receipt, sort_keys=True) + "\n")
    return receipt


if __name__ == "__main__":
    if len(sys.argv) != 8:
        raise SystemExit("usage: process-fixture.py CASE ACTION ACTOR ENTITY BUSINESS_DAY JSON_INPUT FIXTURE_SHA256")
    print(json.dumps(execute(*sys.argv[1:]), sort_keys=True))
