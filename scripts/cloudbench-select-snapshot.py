#!/usr/bin/env python3
"""Select the newest completed Fly volume snapshot from JSON on stdin."""

from __future__ import annotations

import json
import sys


def available_snapshot(records, snapshot_id):
    """Resolve one requested ID's pending/final provider representations.

    Only an empty running placeholder can coexist with a completed record.
    Conflicting positive records and explicit failures never become readiness.
    """
    from datetime import datetime
    import re

    if not isinstance(records,list) or any(not isinstance(row,dict) for row in records):
        raise ValueError('snapshot list shape')
    if not isinstance(snapshot_id,str) or re.fullmatch(r'vs_[A-Za-z0-9]+',snapshot_id) is None:
        raise ValueError('invalid requested snapshot identity')
    matches=[row for row in records if row.get('id')==snapshot_id]
    completed=[]
    volume_sizes=set()
    for row in matches:
        if not {'id','status','created_at','digest','size'} <= row.keys():
            raise ValueError('snapshot representation missing required fields')
        states=[str(row[key]).lower() for key in ('status','state') if row.get(key) is not None]
        if any(value in {'failed','error','cancelled','canceled'} for value in states):
            raise ValueError('snapshot explicitly failed')
        if (type(row['size']) is not int or not isinstance(row['digest'],str)
                or not isinstance(row['created_at'],str) or not isinstance(row['status'],str)):
            raise ValueError('snapshot representation has invalid types')
        if 'volume_size' in row:
            if type(row['volume_size']) is not int or row['volume_size']<=0:
                raise ValueError('snapshot volume size invalid')
            volume_sizes.add(row['volume_size'])
        if all(value in {'running','pending','creating','queued','waiting'} for value in states):
            if row['size']!=0 or row['digest']!='' or row['created_at']!='0001-01-01T00:00:00Z':
                raise ValueError('snapshot pending representation has positive or conflicting data')
            continue
        if not all(value in {'created','complete','completed','ready','available'} for value in states):
            raise ValueError('snapshot representation state conflicts')
        try:created=datetime.fromisoformat(row['created_at'].replace('Z','+00:00'))
        except ValueError as exc:raise ValueError('snapshot completion timestamp invalid') from exc
        if (created.tzinfo is None or created.year<2000 or row['size']<=0
                or re.fullmatch('[0-9a-fA-F]{64}',row['digest']) is None):
            raise ValueError('snapshot completion data invalid')
        completed.append(row)
    if len(volume_sizes)>1:raise ValueError('snapshot volume identity conflicts')
    if not completed:return None
    canonical=json.dumps(completed[0],sort_keys=True,separators=(',',':'),allow_nan=False)
    if any(json.dumps(row,sort_keys=True,separators=(',',':'),allow_nan=False)!=canonical for row in completed[1:]):
        raise ValueError('snapshot completed representations conflict')
    return completed[0]


def select_snapshot(snapshots: list[dict]) -> str:
    completed = [
        snapshot
        for snapshot in snapshots
        if str(snapshot.get("status") or "").lower() in {"created", "complete", "completed", "ready"}
        and str(snapshot.get("created_at") or "") not in {"", "0001-01-01T00:00:00Z"}
        and int(snapshot.get("size") or 0) > 0
        and snapshot.get("id")
    ]
    completed.sort(key=lambda snapshot: str(snapshot.get("created_at") or ""), reverse=True)
    return str(completed[0]["id"]) if completed else ""


def main() -> int:
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--id',dest='snapshot_id',help='Resolve only this recorded snapshot; never creates or retries')
    args=parser.parse_args()
    if args.snapshot_id:
        try:
            result=available_snapshot(json.load(sys.stdin),args.snapshot_id)
        except (ValueError,TypeError) as exc:
            print(str(exc),file=sys.stderr)
            return 2
        print(json.dumps(result,sort_keys=True,separators=(',',':')))
        return 0
    try:
        snapshots = json.load(sys.stdin) or []
    except (json.JSONDecodeError, TypeError):
        snapshots = []
    print(select_snapshot(snapshots))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
