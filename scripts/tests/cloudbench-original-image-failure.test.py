#!/usr/bin/env python3
"""Preserve the actual failed legacy boundary; never retroqualify its receipt."""
import ast
import copy
import hashlib
import json
from pathlib import Path
import re
import unittest

FIXTURE=Path(__file__).resolve().parent/'fixtures/image-preparation-original'

class OriginalFailure(unittest.TestCase):
    def test_exact_original_inventory_refusal_and_immutable_failed_receipt(self):
        manifest=json.loads((FIXTURE/'manifest.json').read_bytes())
        for name in ('legacy_verify_transition.py','native-intent.json','native-result.json'):
            self.assertEqual(hashlib.sha256((FIXTURE/name).read_bytes()).hexdigest(),manifest[name])
        intent=json.loads((FIXTURE/'native-intent.json').read_bytes())
        original=json.loads((FIXTURE/'native-result.json').read_bytes())
        self.assertIs(original['qualified'],False)
        self.assertIs(original['cleanup_complete'],False)
        self.assertIs(original['credit_granted'],False)
        def need(ok,message):
            if not ok:raise ValueError('native maintenance: '+message)
        def digest(value):
            return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        nodes=ast.parse((FIXTURE/'legacy_verify_transition.py').read_text()).body
        self.assertEqual(len(nodes),1)
        self.assertIsInstance(nodes[0],ast.FunctionDef)
        self.assertEqual(nodes[0].name,'verify_transition')
        namespace=dict(need=need,digest=digest,re=re,SCHEMA='cloudbench-native-maintenance-v1')
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'<historical-pure-verifier>','exec'),namespace)
        candidate=copy.deepcopy(original)
        candidate['qualified']=True  # Pre-catch value on a copy, not new authority.
        with self.assertRaisesRegex(ValueError,'^native maintenance: extra/missing inventory target$'):
            namespace['verify_transition'](intent,candidate)
        self.assertIs(original['qualified'],False)
        before=set(intent['before']['inventory']);after=set(original['after']['inventory'])
        self.assertEqual((len(before),len(after),len(after-before),len(before-after)),(45,54,13,4))
        self.assertEqual(hashlib.sha256((FIXTURE/'native-result.json').read_bytes()).hexdigest(),manifest['native-result.json'])

if __name__=='__main__':unittest.main()
