#!/usr/bin/env python3
"""Read-only, as-of display of canonical forensic physical closure receipts."""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import runpy
import stat
import time


def need(value):
    if not value:
        raise ValueError('unverified physical closure report')


def regular(path, limit=None):
    path=Path(path).absolute()
    need(path.resolve(strict=True)==path)
    with path.open('rb') as stream:
        info=os.fstat(stream.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid())
        if limit is not None:
            need(info.st_size<=limit)
            return stream.read(limit+1)
        digest=hashlib.sha256()
        for block in iter(lambda:stream.read(1048576),b''):
            digest.update(block)
        return digest.hexdigest()


def content(path, prefix, limit):
    encoded=regular(path,limit)
    digest=hashlib.sha256(encoded).hexdigest()
    need(Path(path).name==prefix+digest+'.json')
    return json.loads(encoded),digest


def wire(item,path):
    need(set(item)=={'method','path','status','body_b64'} and item['method']=='GET'
         and item['path']==path and type(item['status']) is int)
    return json.loads(base64.b64decode(item['body_b64'],validate=True))


def verified_projection(admission, path, audit, finished_after=None):
    admission=Path(admission).absolute()
    need(admission.resolve(strict=True)==admission and Path(path).parent==admission)
    projection,digest=content(path,'forensic-release-projection-',1048576)
    need(projection['schema']=='cloudbench-forensic-release-projection-v2'
         and projection['scope']=='original-admission-owned-resources')
    for key in ('current_physical_resource_release_verified','all_resources_terminal','old_infra_retained'):
        need(projection[key] is True)
    for key in ('runtime_sealed','claims_released','benchmark_success_inferred'):
        need(projection[key] is False)
    need(projection['original_release_epoch'] is None and type(projection['all_resources_absent']) is bool)
    observed=projection['observed_at']
    need(type(observed) in (int,float) and math.isfinite(observed) and observed>0
         and observed<=time.time() and observed>=audit['observed_at']
         and (not finished_after or observed>=finished_after))
    need(regular(admission/'native-release-audit.json')==projection['original_audit_sha256']
         and audit['schema']=='cloudbench-native-release-audit-v1' and audit['released'] is False
         and projection['historical_retained_owners']==audit['retained_owners'])
    observation_path=Path(projection['observation'])
    need(observation_path.parent==admission)
    observation,observation_sha=content(observation_path,'current-resource-observation-',64*1048576)
    need(observation_sha==projection['observation_sha256']
         and observation['schema']=='cloudbench-current-resource-observation-v1'
         and observation['provider_base']=='https://api.machines.dev'
         and observation['app']==audit['app'] and observation['observed_at']==observed
         and re.fullmatch('[0-9a-f]{40}',observation['source_ref'])
         and observation['selected_forensic_receipt_sha256']==projection['recovery_receipt_sha256']
         and re.fullmatch('[0-9a-f]{64}',projection['recovery_receipt_sha256']))
    app=observation['app_authority']
    need(app['status']==200 and wire(app,'')['name']==audit['app'])
    current=observation['current_native_audit'];checked=audit['checked']
    need(current['schema']==audit['schema'] and current['app']==audit['app']
         and current['checked']==checked and current['present']==[] and current['present_volumes']==[]
         and current['retained_owners']==audit['retained_owners']
         and type(checked['verified_exports']) is int and checked['verified_exports']>0
         and checked['verified_exports']==checked['expected_shards']==projection['verified_exports'])
    inputs=observation['export_inputs']
    need(isinstance(inputs,dict) and inputs)
    typed=runpy.run_path(str(Path(__file__).resolve().parent/'cloudbench-forensic-resource-closure.py'))
    audit_reader=runpy.run_path(str(Path(__file__).resolve().parent/'cloudbench-native-release-audit.py'))
    exports=audit_reader['final_exports'](admission)
    need(len(exports)==projection['verified_exports'])
    required=set()
    for export in exports:
        need(export.parent.parent.parent==admission and export.name=='export')
        for name in ('terminal.json','cleanup-call.intent.json','authority.private.json'):
            required.add(str(export.parent/name))
        for name in ('disposable-export.verified.json','manifest.json','launch.json','originals.tar.gz',
                     'disposable-controller.ownership.json','workspace-volume.ownership.json',
                     'disposable-controller.release.json','disposable-delete-volume.intent.json'):
            required.add(str(export/name))
    # A missing join/authority/terminal must not disappear merely by deleting its
    # key from the supplied map. Only the canonical inventory input is extra.
    need(required<=set(inputs) and len(set(inputs)-required)==1)
    inventory=Path(next(iter(set(inputs)-required)))
    owners=projection['historical_retained_owners']
    need(isinstance(owners,list) and len(owners)==1 and re.fullmatch('[0-9a-f]{32}',owners[0]))
    registry='git-common/cloudbench-fleet-ownership/'+owners[0]+'/meta'
    selected_runs=[export.parent for export in exports if registry in
                   json.loads(typed['S']['manifest_bytes'](export/'manifest.json'))['files']]
    need(len(selected_runs)==1)
    # These are the actual pure original-writer and complete-scope validators.
    # They never instantiate a provider or make native calls.
    selected=typed['prepare'](selected_runs[0],inventory,owners[0])
    _,_,verified,_,proofs,bindings=typed['_full_scope'](admission,selected,inventory)
    need(bindings==inputs and verified==projection['verified_exports']
         and selected['app']==audit['app'] and selected['source_ref']==observation['source_ref'])
    for filename,expected in bindings.items():
        need(re.fullmatch('[0-9a-f]{64}',expected) and regular(filename)==expected)
    subjects=projection['checked_subjects']
    expected_subjects=set(proofs)
    need(subjects==sorted(expected_subjects) and subjects)
    terminal=observation['terminal']
    need(len(terminal)==len(subjects) and {row['subject'].lstrip('/') for row in terminal}==expected_subjects)
    absent=True
    for row in terminal:
        subject=row['subject'];need(re.fullmatch('/(machines/[0-9a-f]{14}|volumes/vol_[a-z0-9]+)',subject))
        need(typed['_terminal'](row['wire'],proofs[subject.lstrip('/')])==row)
        value=wire(row['wire'],subject)
        if row['wire']['status']==404:
            need(row['disposition']=='ABSENT')
        else:
            state='destroyed' if subject.startswith('/machines/') else None
            need(row['wire']['status']==200 and row['disposition']=='PROVIDER_TERMINAL_RETAINED'
                 and value['id']==subject.rsplit('/',1)[1]
                 and value['state']==row['state'] and (value['state']==state if state else value['state'] in {'pending_destroy','destroyed'}))
            absent=False
    need(absent==projection['all_resources_absent'])
    return dict(observed_at=observed,subjects=len(subjects),all_resources_absent=absent,
                projection_sha256=digest,scope=projection['scope'])


def load(admission,audit,finished_after=None):
    """Missing or invalid proof leaves the original card behavior unchanged."""
    candidates=[]
    for path in Path(admission).glob('forensic-release-projection-*.json'):
        try:
            candidates.append(verified_projection(admission,path,audit,finished_after))
        except (OSError,ValueError,KeyError,TypeError,AttributeError):
            continue
    return max(candidates,key=lambda value:value['observed_at']) if candidates else None
