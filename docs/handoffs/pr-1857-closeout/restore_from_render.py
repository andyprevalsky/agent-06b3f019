#!/usr/bin/env python3
"""Obtain only archive recovery fields from the existing Render service, then
use the unchanged native authenticated restore. Never prints/saves key values.
RENDER_API_KEY and RENDER_SERVICE_ID may be in a private bootstrap dotenv file.
The archive's contents are not used to obtain their own decryption key.
"""
import argparse,base64,datetime,hashlib,importlib.util,json,os
from pathlib import Path
from types import SimpleNamespace
import requests
from dotenv import dotenv_values
os.umask(0o077)
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--bootstrap-config',type=Path,default=Path('back-end/.env'));p.add_argument('--receipt',type=Path,required=True);p.add_argument('--destination',type=Path,required=True);p.add_argument('--proof',type=Path,required=True);a=p.parse_args()
bootstrap=dotenv_values(a.bootstrap_config);token=os.environ.get('RENDER_API_KEY') or bootstrap.get('RENDER_API_KEY');service=os.environ.get('RENDER_SERVICE_ID') or bootstrap.get('RENDER_SERVICE_ID');bootstrap.clear()
if not token or service!='srv-d3jga77diees73cgrvk0':raise SystemExit('Missing Render access or unexpected service identity')
wanted={'TRACE_ARCHIVE_ENCRYPTION_KEY_B64','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_TRACE_ARCHIVE'};values={};cursor=None;pages=0
endpoint=f'https://api.render.com/v1/services/{service}/env-vars'
for page in range(20):
 params={'limit':100}
 if cursor:params['cursor']=cursor
 r=requests.get(endpoint,params=params,headers={'Authorization':'Bearer '+token},timeout=30)
 if not r.ok:raise SystemExit(f'Render GET failed HTTP{r.status_code}; raw response suppressed')
 body=r.json();pages+=1
 if not isinstance(body,list):raise SystemExit('Unexpected Render response; suppressed')
 for row in body:
  item=row.get('envVar') or {}
  if item.get('key') in wanted:values[item['key']]=item.get('value') or ''
 if wanted.issubset(values):break
 if not body or len(body)<100 or not body[-1].get('cursor'):break
 cursor=body[-1]['cursor']
if not wanted.issubset(values):raise SystemExit('Required recovery fields absent; no fallback to archived key')
fingerprint=hashlib.sha256(base64.b64decode(values['TRACE_ARCHIVE_ENCRYPTION_KEY_B64'],validate=True)).hexdigest()
if fingerprint!='e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730' or values['R2_BUCKET_TRACE_ARCHIVE']!='trace-archive':raise SystemExit('Recovery identity mismatch')
helper=Path('docs/handoffs/whm-b07d9037-preservation/private_archive.py');spec=importlib.util.spec_from_file_location('native_private_archive',helper);native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
# Configuration adapter only: existing client/framing/AAD/decrypt/hash/restore code is unchanged.
native.dotenv_values=lambda path:values if str(path) in ['/home/boxes/rose/agents/.env','/home/boxes/rose/back-end/.env'] else {}
native.restore(SimpleNamespace(receipt=str(a.receipt),destination=str(a.destination)))
receipt=json.loads(a.receipt.read_text());proof={'format':'PR1857-RENDER-BOOTSTRAP-RESTORE-V1','verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':endpoint,'http_method':'GET','pages_read':pages,'native_helper_sha256':hashlib.sha256(helper.read_bytes()).hexdigest(),'archive_key':receipt['key'],'files':receipt['files'],'key_decoded_sha256':fingerprint,'r2_credentials_source':'same existing Render service environment','used_archived_key_for_bootstrap':False,'raw_provider_response_saved':False,'secret_values_printed_or_logged':False,'native_authenticated_restore_succeeded':True,'destination':str(a.destination)}
a.proof.write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps({'native_authenticated_restore_succeeded':True,'files':receipt['files'],'proof':str(a.proof)}))
