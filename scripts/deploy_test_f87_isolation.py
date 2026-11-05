"""Execution-only compatibility for the exact retained f87 reserve-abort campaign.
No historical provenance, cleanup credit, or provider-mutation claim is created.
"""
import hashlib
import json
import os
from pathlib import Path
import time
from deploy_test_startup_compat import observe

SOURCE='f87a389979fd30826a1b133cb445cc0f648d3536'
TOKEN='c55d018b32624719a8c9ac8b0686afe7'
RECEIPT_SHA='f786212627959dfb102e8de061042b982efa67aed2761f85378429427aabe137'
PINNED={'.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/result.json': '77fbf135e40f47e0f3bd68dd17ea7fb3b4161cb35518f6463fcf2805d1b4f054', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/source-transport.json': '443b202655872e831e47d2fa68df07f04612dec5e765924d7dd95ff69e8af8cd', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/workspace.patch': 'f55cdc508ca38db048c7185e89f069f7d5bd412d606a11ae8c0ecd114596c641', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/campaigns/deploy-e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/summary.json': '520976b4d0abb322a2deaf941d8f02cc284d9c3776117fcd3a1b5843e1a73beb', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/runs/20261105-050518-2258485/_batch/lifecycle.json': 'f4957d410a8dd81ea385951d224f5805975f31ad836e66a801730ba1c91d00f8', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/runs/20261105-050518-2258492/_batch/lifecycle.json': 'e353e31a4fd266f5d73c58e59baba6298a7be14861492cdd0261eb4c121b02d4', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/runs/20261105-050519-2258479/_batch/lifecycle.json': 'f1480b0a24e5b4926c361af4208b5a441e8d29f721752cd8c95c15553b63e813', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/runs/20261105-050519-2258512/_batch/lifecycle.json': 'b5ef404697e38b9b1b7e8ef6cd032b3fbac24a9d8cf52524be05ba73381c5bb1', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/runs/20261105-050519-2258550/_batch/lifecycle.json': '16262972c45f9b3699eb521c157c2be2ad8c028f6dbeddf5a6d06c42e1ee61dd', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/runs/20261105-050519-2258551/_batch/lifecycle.json': '65228f5c4c0f2b0387e408b0d00949a7dc090776f8ed3372dd50dc67459b3bf7', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/runs/20261105-050519-2258554/_batch/lifecycle.json': 'e110b5308b79e104eedbb63c1250a47f2fddf4b69662cf758538c4d8b2eae20b', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/runs/20261105-050519-2258564/_batch/lifecycle.json': '971601adc0b18249a4315fbe7ac82a04ea80da8bbe3a621a87ba1ae1ea928d66', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/runs/20261105-050520-2258521/_batch/lifecycle.json': '1eedd58215fcb6462089a0e458a0062b7cad0316b60671fc329ff3334e8b5383', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/runs/20261105-050520-2258531/_batch/lifecycle.json': 'c1e9469e0a6c1b003fc8997c791da9c02b938cd4e760deef88e5d3917bbff001', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/campaigns/deploy-e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/shared-relay-location.json': '90ac0f274594bc4ce8bbeb38e05983762291b5bd708da51846767d9f28990d89', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/runs/_hub/agent-link-server.18764.045cb35b6df6e0dbb2e39a8d7811ded5.owner': 'e04196b40f3d22ce5b360f13902fc5bc47594b3e6ba22710f8a4057710e02b13', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/runs/_hub/agent-link-server.18764.0f0270344752692ffeec6c22892d9c5a.owner': '67e65c13d3a93e1e78ac466289ed2f7ddeec10657947b5c6b265bab26b6e24c5', '.context/deploy-cloud/e92e025c48abd2af922ba1ad67b26d1f9335663e15bde4a469d1877b5a85096b/runs/_hub/agent-link-server.18764.832b8aa492bc1bc86d7ec32fc06a31c1.owner': '4ab0ed2f54a3a64c6e392eb5a52190f570814ce9c7005ec48cef635e5780625b'}


def hub_identity(pid):
    proc=Path('/proc')/str(pid)
    birth='proc-start:'+Path('/proc/sys/kernel/random/boot_id').read_text().strip()+':'+(proc/'stat').read_text().rsplit(') ',1)[1].split()[19]
    argv=(proc/'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
    return birth,hashlib.sha256(b'\0'.join(argv[1:])).hexdigest()


def validate(receipt, adapter, proof, root, runs, participants, document, bound, tree):
    from deploy_test_native_cleanup import need, fields
    need(proof.get('purpose')=='isolated-validation' and proof.get('layout')=='campaign-v1'
         and proof.get('compatibility')=='f87-reserve-abort-isolation-v1'
         and receipt['source']['head']==SOURCE and receipt['token']==TOKEN
         and proof['receipt_sha256']==RECEIPT_SHA, 'unreviewed pre-provenance compatibility')
    required_owners={str(root/relative):expected for relative,expected in PINNED.items()
                     if (root/relative).parent==runs/'_hub' and relative.endswith('.owner')}
    supplied_owners={path for path in proof.get('files',{})
                     if Path(path).parent==runs/'_hub' and path.endswith('.owner')}
    need(len(required_owners)==3 and supplied_owners==set(required_owners)
         and all(proof['files'].get(path)==value for path,value in required_owners.items()),
         'all three original Hub debts must remain pinned')
    for relative, expected in PINNED.items():
        need(hashlib.sha256(bound(root/relative)).hexdigest()==expected,'original f87 evidence changed')
    campaign=runs.parent/'campaigns'/('deploy-'+runs.parent.name)
    summary=document(campaign/'summary.json')
    need(len(participants)==10 and {p.name.rsplit('-',1)[-1] for p in participants}
         == {str(j['controller_pid']) for j in summary['jobs']}, 'original participant closure')
    hubs=set()
    for fleet in participants:
        life=document(fleet/'_batch/lifecycle.json');owner=life['fleet_owner_token']
        local=fleet/'teardown-ownership';canonical=root/'.git/cloudbench-fleet-audits'/owner
        need(tree(local)==tree(canonical)==life['audit_sha256'],'original native audit changed')
        meta=fields(bound(canonical/'meta'));hubs.add(meta['hub_owner_file'])
        need(not (fleet/'execution-provenance.json').exists()
             and not (fleet/'execution-task-matrix.json').exists(), 'historical provenance was added')
        need(bound(canonical/'owned-clones.ids')==bound(canonical/'owned-clones.names')==b'',
             'original inventory is not empty')
        for name in ('fresh','pool','pool-handoffs','volume-migrations'):
            folder=canonical/name
            need(not folder.exists() or folder.is_dir() and not folder.is_symlink() and not any(folder.iterdir()),
                 'original resource custody is ambiguous')
    need(len(hubs)==1,'ambiguous retained Hub')
    hub=fields(bound(Path(next(iter(hubs)))))
    pid=int(hub['pid']);birth,argv_hash=hub_identity(pid)
    need(birth==hub['pid_start'] and argv_hash==hub['argv_sha256'], 'retained Hub incarnation changed')
    relay=document(campaign/'shared-relay-location.json')['directory']
    pids={j['controller_pid'] for j in summary['jobs']}|{pid}
    scopes=[str(runs.parent),relay]
    observation=document(Path(proof['investigator_observation']))
    need(observation.get('schema')=='f87-isolated-observation-v1'
         and receipt['finished_at']<=observation.get('observed_at',0)<=proof['confirmed_at'],
         'fresh investigator observation required')
    current=observe(pids,scopes);saved=observation.get('os',{})
    need(all(saved.get(k)==current[k] for k in ('boot_id','uid','pids','scopes','matched','unreadable'))
         and current['matched']==[pid] and current['unreadable']==[]
         and receipt['finished_at']<=saved.get('observed_at',0)<=proof['confirmed_at'],
         'old execution is active or unknown')
    return True
