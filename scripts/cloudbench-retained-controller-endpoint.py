#!/usr/bin/env python3
"""Source-bound cold handoff on a retained controller without replacing its init."""
from pathlib import Path
import hashlib
import json
import os
import runpy
import subprocess

HERE = Path(__file__).resolve().parent
BASE = runpy.run_path(str(HERE / 'cloudbench-startup-failure-archive.py'))


def verify_retained_endpoint(workspace, source_ref, native, retained):
    required = {'record', 'original_native', 'original_native_sha256'}
    if not isinstance(retained, dict) or set(retained) != required:
        raise ValueError('retained endpoint requires exact original native and continuation records')
    path = HERE / 'cloudbench-controller-export.py'
    raw = BASE['read'](path)
    expected = subprocess.check_output(['git', '-c', 'safe.directory='+str(workspace), '--no-replace-objects', '-C', str(workspace),
        'show', source_ref + ':scripts/cloudbench-controller-export.py'])
    if raw != expected:
        raise ValueError('retained endpoint exporter differs from pinned source')
    exporter = runpy.run_path(str(path))
    return exporter['retained_controller_endpoint'](retained['record'], workspace, source_ref,
        native, retained['original_native'], retained['original_native_sha256'])


def capture_retained_target(workspace, common, before, after, ownership, source_ref, pool_name, *, retained, controller_volume, with_record=False):
    workspace, common = Path(workspace), Path(common)
    if (workspace.resolve(strict=True) != workspace or common.resolve(strict=True) != common
            or not workspace.is_dir() or not common.is_dir()):
        raise ValueError('unsafe retained endpoint paths')
    first, last = json.loads(BASE['read'](before, 1048576)), json.loads(BASE['read'](after, 1048576))
    if first != last:
        raise ValueError('retained endpoint changed between native observations')
    record = verify_retained_endpoint(workspace, source_ref, first, retained)
    config = first['config']; mounts = config.get('mounts', [])
    if (len(mounts) != 1 or config.get('restart') != {'policy': 'no'}
            or config.get('auto_destroy') not in (None, False)):
        raise ValueError('retained endpoint lifecycle is not preserved')
    mount = Path(mounts[0]['path'])
    preservation = 'rootfs-always' if config.get('rootfs') == {'persist': 'always', 'size_gb': 50} else 'same-volume-device'
    if preservation == 'same-volume-device' and (mount.resolve(strict=True) != mount
            or not os.path.ismount(mount) or mount.stat().st_dev != common.stat().st_dev):
        raise ValueError('retained endpoint lacks durable common custody')
    owner_raw = BASE['read'](ownership, 1048576); owner = json.loads(owner_raw)
    if (owner.get('schema') != 'cloudbench-controller-workspace-ownership-v1'
            or owner.get('volume_id') != mounts[0]['volume']
            or owner.get('app') != os.environ.get('FLY_APP_NAME')
            or owner.get('mount_path') != str(mount)):
        raise ValueError('retained endpoint workspace ownership differs')
    volume = json.loads(BASE['read'](controller_volume, 1048576))
    if (volume.get('id') != mounts[0]['volume'] or volume.get('attached_machine_id') != first['id']
            or volume.get('state') != 'created'):
        raise ValueError('retained endpoint Volume attachment differs')
    actual_common = subprocess.check_output(['git', '-c', 'safe.directory='+str(workspace), '-C', str(workspace), 'rev-parse', '--path-format=absolute', '--git-common-dir'], text=True).strip()
    actual_ref = subprocess.check_output(['git', '-c', 'safe.directory='+str(workspace), '-C', str(workspace), 'rev-parse', 'HEAD'], text=True).strip()
    if Path(actual_common).resolve(strict=True) != common or actual_ref != source_ref:
        raise ValueError('retained endpoint source or physical common differs')
    # Continuation verifies the same immutable ownership bytes as this endpoint.
    if record.get('workspace_ownership_sha256') != hashlib.sha256(owner_raw).hexdigest():
        raise ValueError('retained endpoint continuation ownership differs')
    endpoint = BASE['handoff_target'](dict(machine=first['id'], volume=mounts[0]['volume'], workspace=str(workspace),
        common=str(common), source_ref=source_ref, ownership_sha256=hashlib.sha256(owner_raw).hexdigest(),
        controller_config_sha256=hashlib.sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        preservation=preservation, pool_name=pool_name))
    return (endpoint, record) if with_record else endpoint



def _descriptor(path):
    raw=BASE['read'](path)
    return {'path':str(path),'sha256':hashlib.sha256(raw).hexdigest()}


def verify_target_source_successor(value, packet, current_target, *, live=True):
    """Revalidate explicit source succession through the canonical live endpoint."""
    keys={'schema','packet_sha256','original_target','current_target','old_ref','new_ref',
          'inputs','continuation','root_anchors'}
    if not isinstance(value,dict) or set(value)!=keys or value['schema']!='cloudbench-target-source-successor-v1':
        raise ValueError('invalid target source successor proof')
    original=BASE['handoff_target'](packet['target']);current=BASE['handoff_target'](current_target)
    if (value['original_target']!=original or value['current_target']!=current
            or value['old_ref']!=original['source_ref'] or value['new_ref']!=current['source_ref']
            or value['old_ref']==value['new_ref']
            or any(original[k]!=current[k] for k in original if k!='source_ref')):
        raise ValueError('target source successor endpoint differs')
    # Bind the exact immutable packet bytes, not a reserialized approximation.
    inputs=value['inputs']
    if set(inputs)!={'packet','record','original_native','controller_before','controller_after','controller_volume','workspace_ownership'}:
        raise ValueError('target source successor inputs differ')
    for item in inputs.values():
        if set(item)!={'path','sha256'} or hashlib.sha256(BASE['read'](item['path'])).hexdigest()!=item['sha256']:
            raise ValueError('target source successor input changed')
    raw=BASE['read'](inputs['packet']['path'])
    if hashlib.sha256(raw).hexdigest()!=value['packet_sha256'] or json.loads(raw)!=packet:
        raise ValueError('target source successor packet changed')
    if live:
        observed,record=capture_retained_target(current['workspace'],current['common'],
            inputs['controller_before']['path'],inputs['controller_after']['path'],
            inputs['workspace_ownership']['path'],value['new_ref'],current['pool_name'],
            retained={'record':inputs['record']['path'],'original_native':inputs['original_native']['path'],
                      'original_native_sha256':inputs['original_native']['sha256']},
            controller_volume=inputs['controller_volume']['path'],with_record=True)
        if observed!=current or record['continuation']!=value['continuation'] or record['root_anchors']!=value['root_anchors']:
            raise ValueError('target source successor continuation/roots changed')
    else:
        # Completion already records canonical live admission. Later consumers
        # retain physical/source/ownership checks without reviving the old PID.
        for name, expected in value['root_anchors'].items():
            path=Path(name)
            if path.resolve(strict=True)!=path:
                raise ValueError('successor completed root is linked')
            info=path.stat()
            actual=dict(device=info.st_dev,inode=info.st_ino,mode=info.st_mode,uid=info.st_uid)
            if any(actual[key]!=item for key,item in expected.items()):
                raise ValueError('successor completed physical root changed')
        if set(value['root_anchors'])!={current['workspace'],current['common']}:
            raise ValueError('successor completed root set differs')
        workspace=current['workspace']
        actual_common=subprocess.check_output(['git','-c','safe.directory='+workspace,'-C',workspace,'rev-parse','--path-format=absolute','--git-common-dir'],text=True).strip()
        actual_ref=subprocess.check_output(['git','-c','safe.directory='+workspace,'-C',workspace,'rev-parse','HEAD'],text=True).strip()
        dirty=subprocess.check_output(['git','-c','safe.directory='+workspace,'-C',workspace,'diff','--name-only','HEAD','--','scripts'],text=True).strip()
        if actual_common!=current['common'] or actual_ref!=current['source_ref'] or dirty:
            raise ValueError('successor completed actual source/common changed')
        if hashlib.sha256(BASE['read'](inputs['workspace_ownership']['path'])).hexdigest()!=current['ownership_sha256']:
            raise ValueError('successor completed ownership changed')
    # No arbitrary ref mapping: the actual current checkout must descend from
    # the exact original target source, under the unchanged physical custody.
    subprocess.run(['git','--no-replace-objects','-c','safe.directory='+current['workspace'],'-C',current['workspace'],
                    'merge-base','--is-ancestor',value['old_ref'],value['new_ref']],check=True,
                   stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=10)
    return value


def create_target_source_successor(request, endpoint):
    authorization=request['target_source_successor']
    if set(authorization)!={'old_ref','new_ref','receipt_output'}:
        raise ValueError('explicit target source successor authorization required')
    raw=BASE['read'](request['packet']);packet=json.loads(raw)
    if (hashlib.sha256(raw).hexdigest()!=request['packet_sha256']
            or packet['target']!=request['target']
            or authorization['old_ref']!=packet['target']['source_ref']
            or authorization['new_ref']!=endpoint['source_ref']):
        raise ValueError('target source successor authorization differs')
    retained=request['retained_controller']
    inputs={key:_descriptor(path) for key,path in {
        'packet':request['packet'],'record':retained['record'],'original_native':retained['original_native'],
        'controller_before':request['controller_before'],'controller_after':request['controller_after'],
        'controller_volume':request['controller_volume'],'workspace_ownership':request['workspace_ownership']}.items()}
    if inputs['original_native']['sha256']!=retained['original_native_sha256']:
        raise ValueError('target source successor original native changed')
    record=json.loads(BASE['read'](retained['record']))
    value={'schema':'cloudbench-target-source-successor-v1','packet_sha256':request['packet_sha256'],
           'original_target':packet['target'],'current_target':endpoint,
           'old_ref':authorization['old_ref'],'new_ref':authorization['new_ref'],'inputs':inputs,
           'continuation':record['continuation'],'root_anchors':record['root_anchors']}
    verify_target_source_successor(value,packet,endpoint)
    BASE['durable_handoff_json'](authorization['receipt_output'],value)
    return _descriptor(authorization['receipt_output'])


def cold_handoff_request(request_path, expected_sha, workspace, common):
    """Same explicit request/claim FSM, using a proven retained endpoint."""
    request = BASE['read_cold_handoff_request'](request_path, expected_sha)
    endpoint = capture_retained_target(workspace, common, request['controller_before'], request['controller_after'],
        request['workspace_ownership'], request['tool_ref'], request['pool_name'],
        retained=request['retained_controller'], controller_volume=request['controller_volume'])
    if endpoint != request['endpoint']:
        raise ValueError('retained endpoint differs from explicit request')
    operation = request['operation']
    if operation == 'target':
        BASE['durable_handoff_json'](request['target_output'], endpoint)
        return endpoint
    volume = json.loads(BASE['read'](request['native_volume'], 1048576))
    if (volume.get('id') != request['volume'] or volume.get('attached_machine_id') != request['machine']
            or volume.get('state') != 'created'):
        raise ValueError('retained handoff child Volume attachment differs')
    if operation == 'export':
        registry = Path(request['registry'])
        if registry.parent != Path(common) / 'cloudbench-fleet-ownership':
            raise ValueError('retained export registry belongs to another common')
        return BASE['export_cold_handoff'](common, registry, request['output'], request['machine'], request['run_token'],
            request['receipt'], request['native_before'], request['native_after'], request['target'], request['nonce'],
            request['packet_output'], source_endpoint=endpoint)
    if operation == 'import':
        if hashlib.sha256(BASE['read'](request['packet'])).hexdigest() != request['packet_sha256']:
            raise ValueError('retained import target/packet differs')
        successor=None
        if request['target'] != endpoint:
            if 'target_source_successor' not in request:
                raise ValueError('retained import target/packet differs')
            successor=create_target_source_successor(request,endpoint)
        elif 'target_source_successor' in request:
            raise ValueError('target source successor cannot authorize an unchanged target')
        return BASE['import_cold_handoff'](common, endpoint, request['packet'], request['native_before'], request['native_after'],
                                           target_source_successor=successor)
    raise ValueError('unsupported retained handoff operation')
