#!/usr/bin/env python3
"""List a retired native world session's committed steps: tool, selected outcome, probability.

usage: session-outcomes.py <wmh root> <session id>
Proposals are not commits; only the retirement receipt's history is the committed trajectory.
"""

from __future__ import annotations

import collections
import json
import sys
from pathlib import Path

receipt = json.loads((Path(sys.argv[1]) / "native-retirements" / f"{sys.argv[2]}.json").read_text())
tools = collections.Counter()
for index, step in enumerate(receipt["history"], 1):
    name = (step["action"].get("name") or "").split(".")[-1]
    metadata = step["observation"].get("metadata") or {}
    selection = metadata.get("outcome_selection") or {}
    merged = metadata.get("append_merged_from_revision")
    tools[name] += 1
    print(
        f"{index:3d} {name:28s} {str(selection.get('selected_outcome_id')):40s} "
        f"p={selection.get('probability')}" + (f" merged_from={merged}" if merged is not None else "")
    )
print("\ncommitted steps:", dict(tools), "revision:", receipt.get("revision"), "joined:", receipt.get("join_verified"))
