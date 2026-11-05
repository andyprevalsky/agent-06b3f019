#!/usr/bin/env python3
"""Future producer evidence for a reserve refusal before resource admission."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from cloudbench_execution_provenance import build_config, build_provenance, build_task_matrix, verify_snapshot

SCHEMA = 'cloudbench-preallocation-v1'

def write_once(path, value):
    with path.open('x') as f:
        json.dump(value, f, sort_keys=True); f.write('\n'); f.flush(); os.fsync(f.fileno())
    path.chmod(0o444)

def prepare(args):
    manifest=json.loads(args.manifest.read_text());verify_snapshot(args.snapshot,manifest)
    matrix=build_task_matrix(args.task)
    provenance=build_provenance(base_sha=args.base,workspace_patch_sha256=args.patch,
        snapshot_manifest=manifest,config=build_config('cloudbench-fleet-config-v1',
        ['app='+args.app,'task_count='+str(len(matrix['tasks'])),'task_matrix_sha256='+matrix['sha256']]))
    source=subprocess.check_output(['git','-C',str(args.root),'rev-parse','HEAD'],text=True).strip()
    write_once(args.run/'preallocation-source.json',dict(schema=SCHEMA,source=source,run_id=args.run.name,
        producer_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        owner=args.owner,pid=args.pid,birth=args.birth,created_at=time.time(),
        execution_provenance=provenance,task_matrix=matrix))

def abort(args):
    path=args.run/'preallocation-source.json';value=json.loads(path.read_text())
    if (value['owner']!=args.owner or value['pid']!=args.pid or value['birth']!=args.birth
            or value['run_id']!=args.run.name or (args.run/'resource-admission.entered').exists()):
        raise ValueError('preallocation owner or boundary changed')
    if args.exit_code not in (1,129,130,143) or args.stage not in ('cleanup-reserve-refused','preallocation-interrupted'):
        raise ValueError('not an early failure')
    if args.stage == 'cleanup-reserve-refused' and args.exit_code != 1:
        raise ValueError('reserve refusal exit mismatch')
    write_once(args.run/'preallocation-abort.json',dict(schema=SCHEMA,stage=args.stage,
        source_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),owner=args.owner,pid=args.pid,
        birth=args.birth,run_id=args.run.name,native_exit=args.exit_code,finished_at=time.time()))

def main():
    p=argparse.ArgumentParser();p.add_argument('operation',choices=['prepare','abort']);p.add_argument('--run',type=Path,required=True)
    p.add_argument('--owner',required=True);p.add_argument('--pid',type=int,required=True);p.add_argument('--birth',required=True)
    p.add_argument('--exit-code',type=int,default=1);p.add_argument('--stage',default='cleanup-reserve-refused')
    p.add_argument('--root',type=Path);p.add_argument('--base');p.add_argument('--patch');p.add_argument('--app')
    p.add_argument('--snapshot',type=Path);p.add_argument('--manifest',type=Path);p.add_argument('--task',action='append',default=[])
    a=p.parse_args();prepare(a) if a.operation=='prepare' else abort(a)
if __name__=='__main__':main()
