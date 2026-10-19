#!/usr/bin/env python3
"""Union known resource protections before selecting any idle candidates.

This is an exclusion index, never proof of ownership, idleness or admission.
Every supplied source is required; conflicting evidence only adds exclusions.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re


def combine(sources):
    machines, volumes, names, evidence = set(), set(), set(), []

    def add(row, source):
        mid = row.get('machine', row.get('machine_id', row.get('recorded_id', row.get('id'))))
        vol = row.get('volume', row.get('volume_id', row.get('recorded_volume')))
        name = row.get('name', row.get('clone_name'))
        if mid:
            if not re.fullmatch(r'[0-9a-f]{14}', mid):
                raise ValueError('invalid protected Machine identity')
            machines.add(mid)
        if vol:
            if not re.fullmatch(r'vol_[A-Za-z0-9_-]+', vol):
                raise ValueError('invalid protected Volume identity')
            volumes.add(vol)
        if name:
            names.add(name)
        if not (mid or vol or name):
            raise ValueError('protection without resource identity')
        evidence.append(dict(source=source, machine=mid, volume=vol, name=name))

    def held(row):
        # Missing policy cannot turn incomplete owner evidence into permission.
        return (row.get('cleanup_policy') != 'reap'
                or any(row.get('latches', {}).values())
                or any(row.get(k) for k in ('claimed', 'held', 'active_consumer')))

    for source, data in sources:
        if 'identities' in data:
            for row in data['identities']:
                add(row, source)
        elif data.get('kind') == 'historical-retain-policy-owner-clones':
            for row in data['clones']:
                add(row['clone'], source)
        elif 'matches' in data:
            for row in data['matches']:
                if held(row):
                    add(row, source)
        elif 'owners' in data:
            for owner in data['owners']:
                if held(owner):
                    for row in owner['clones']:
                        add(row, source)
        elif data and all(isinstance(k, str) and k.startswith('git-common/')
                          and isinstance(v, str) for k, v in data.items()):
            def fields(raw):
                if raw.lstrip().startswith('{'):
                    # durable_handoff_json writers (explicit-idle PENDING claim,
                    # imported worker claim) record JSON, not key=value lines.
                    result = json.loads(raw)
                    if not isinstance(result, dict):
                        raise ValueError('malformed protection record')
                    return result
                result = {}
                for line in raw.splitlines():
                    if not line:
                        continue
                    if '=' not in line:
                        raise ValueError('malformed protection record')
                    key, value = line.split('=', 1)
                    if not key or key in result:
                        raise ValueError('duplicate protection field')
                    result[key] = value
                return result
            prefix = 'git-common/cloudbench-fleet-ownership/'
            for path, raw in data.items():
                if path.startswith(prefix) and '/clones/' in path:
                    owner_path = path.split('/clones/', 1)[0]
                    meta_raw = data.get(owner_path+'/meta')
                    meta = fields(meta_raw) if meta_raw is not None else {}
                    latch = any(k.startswith(owner_path+'/') and
                                any(part in ('recovery-lock', 'runtime-evidence-unconfirmed', 'guest-cleanup-unconfirmed', 'cold-handoff-outgoing')
                                    for part in k[len(owner_path)+1:].split('/'))
                                for k in data)
                    row = fields(raw)
                    if held(meta) or latch:
                        add(row, source+':'+path)
                elif '/cloudbench-pool-claims/' in path or '/cloudbench-cold-handoffs/outgoing/' in path:
                    row = fields(raw)
                    if re.fullmatch(r'[0-9a-f]{14}', path.rsplit('/', 1)[-1]):
                        row.setdefault('machine_id', path.rsplit('/', 1)[-1])
                    add(row, source+':'+path)
        else:
            raise ValueError('unsupported protection source: '+source)
    return dict(schema='cloudbench-protected-resource-union-v1', machines=sorted(machines),
                volumes=sorted(volumes), names=sorted(names), evidence=evidence,
                admission_authorized=False)


def select(candidates, protection):
    return [row for row in candidates if row['id'] not in protection['machines']
            and row.get('name') not in protection['names']
            and not any(v.get('volume') in protection['volumes']
                        for v in row.get('config', {}).get('mounts', []))]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', required=True, help='JSON list of required path/sha256 descriptors')
    args = parser.parse_args()
    sources = []
    for item in json.loads(Path(args.sources).read_text()):
        raw = Path(item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('protection source changed')
        sources.append((item['path'], json.loads(raw)))
    if not sources:
        raise ValueError('no protection sources')
    print(json.dumps(combine(sources), sort_keys=True))


if __name__ == '__main__':
    main()
