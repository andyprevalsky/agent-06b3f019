#!/usr/bin/env python3
"""Source publication/consumer version contract at the real CLI boundary."""
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ.get('CLOUDBENCH_SOURCE_UNDER_TEST', str(ROOT / 'scripts/cloudbench-source.py')))
M = runpy.run_path(str(SOURCE))


class SourceVersion(unittest.TestCase):
    def setUp(self):
        self.v1 = dict(version=1, app='navi-whisper-lux-bench', owner_token='a'*32,
            machine_id='11111111111111', instance_id='instance1', machine_name='cloudbench-source-'+'a'*32,
            volume_id='vol_owned', region='iad', image_digest='sha256:'+'b'*64, snapshot_id='vs_owned',
            node_fingerprint='c'*64, python_fingerprint='d'*64, verified_at=1794260000,
            shared_machine_id='683e47df5094d8', shared_volume_id='vol_vwnym366kn7k8mmv')
        self.v2 = dict(self.v1, version=2, lease_protocol='cloudbench-source-lease-v1', creation_nonce='e'*32, guest_env_sha256={'AGENTS_ENV_B64':'1'*64,'BACKEND_ENV_B64':'2'*64})
        self.machine = dict(id=self.v1['machine_id'], instance_id='instance1', name=self.v1['machine_name'],
            state='stopped', region='iad', image_ref={'digest': self.v1['image_digest']},
            config={'image':'registry.fly.io/navi-whisper-lux-bench@'+self.v1['image_digest'],
                'mounts':[{'volume':'vol_owned','path':'/data'}],
                'guest':{'cpu_kind':'shared','cpus':1,'memory_mb':2048},
                'metadata':{'cloudbench_source_owner':'a'*32}})
        self.inventory = dict(machines=[self.machine, {'id':self.v1['shared_machine_id'],'name':'cloudbench-warm',
            'config':{'mounts':[{'volume':self.v1['shared_volume_id'],'path':'/data'}]}}],
            volumes=[{'id':'vol_owned','state':'created','region':'iad','attached_machine_id':self.v1['machine_id']}],
            snapshots=[{'id':'vs_owned','status':'created','size':100,'created_at':'2026-11-09T21:33:20Z'}])

    def test_legacy_schema_and_native_behavior_preserved(self):
        self.assertEqual(M['manifest'](json.dumps(self.v1).encode()), self.v1)
        M['verify'](self.v1, self.inventory, parked_memory=2048)

    def test_v2_requires_native_protocol_and_creation_nonce(self):
        self.assertEqual(M['manifest'](json.dumps(self.v2).encode()), self.v2)
        with self.assertRaises(ValueError): M['verify'](self.v2, self.inventory, parked_memory=2048)
        self.machine['config']['metadata'].update(cloudbench_source_protocol='cloudbench-source-lease-v1',
            cloudbench_source_create_nonce='e'*32)
        M['verify'](self.v2, self.inventory, parked_memory=2048)
        self.machine['config']['metadata']['cloudbench_source_create_nonce']='f'*32
        with self.assertRaises(ValueError): M['verify'](self.v2, self.inventory, parked_memory=2048)

    def test_v1_cannot_downgrade_a_protocol_source(self):
        self.machine['config']['metadata']['cloudbench_source_protocol']='cloudbench-source-lease-v1'
        with self.assertRaises(ValueError): M['verify'](self.v1, self.inventory, parked_memory=2048)

    def test_retiring_source_refuses_admission(self):
        self.machine['config']['metadata'].update(cloudbench_source_protocol='cloudbench-source-lease-v1',
            cloudbench_source_create_nonce='e'*32, cloudbench_source_retiring='original retirement')
        with self.assertRaises(ValueError): M['verify'](self.v2, self.inventory, parked_memory=2048)

    def test_unknown_partial_or_wrong_protocol_refuses(self):
        for key, val in [('version',3),('version',True),('lease_protocol','unknown'),('creation_nonce','bad'),('guest_env_sha256',{}),('guest_env_sha256',{'AGENTS_ENV_B64':'1'*64,'BACKEND_ENV_B64':'bad'}),('extra','unknown')]:
            candidate = dict(self.v2);candidate[key]=val
            with self.assertRaises(ValueError):M['manifest'](json.dumps(candidate).encode())
        candidate = dict(self.v2);candidate.pop('creation_nonce')
        with self.assertRaises(ValueError):M['manifest'](json.dumps(candidate).encode())

    def test_cli_protocol_preserves_field_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'manifest.json';path.write_text(json.dumps(self.v2))
            result=subprocess.run([sys.executable,str(SOURCE),'protocol',str(path)],capture_output=True,text=True,timeout=8)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(result.stdout.strip(),'cloudbench-source-lease-v1')
            result=subprocess.run([sys.executable,str(SOURCE),'fields',str(path)],capture_output=True,text=True,timeout=8)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(len(result.stdout.split()),9)


if __name__ == '__main__':unittest.main()
