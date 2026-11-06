#!/usr/bin/env python3
"""Portable configuration/receipt adapter for the existing framed archive helper.
No archive implementation is duplicated. All restore/verify work delegates to it.
"""
import argparse,base64,hashlib,importlib.util,json,os
from pathlib import Path

def configured_recipe(recipe_path, config_files, escrow_file, expected_fingerprint):
    spec=importlib.util.spec_from_file_location('legacy_private_archive',recipe_path)
    recipe=importlib.util.module_from_spec(spec);spec.loader.exec_module(recipe)
    values={}
    for path in config_files:
        values.update({k:v for k,v in recipe.dotenv_values(path).items() if v})
    escrow=recipe.dotenv_values(escrow_file)
    key=escrow.get('PR1634_ARCHIVE_RECOVERY_KEY_B64')
    if not key:raise RuntimeError('Managed escrow key is absent')
    decoded=base64.b64decode(key,validate=True)
    if len(decoded)!=32 or hashlib.sha256(decoded).hexdigest()!=expected_fingerprint:
        raise RuntimeError('Recovery key fingerprint mismatch')
    values['TRACE_ARCHIVE_ENCRYPTION_KEY_B64']=key
    if values.get('R2_BUCKET_TRACE_ARCHIVE')!='trace-archive':raise RuntimeError('Unexpected recovery bucket')
    # Adapt only configuration loading; preserve legacy connection/framing/AAD/restore.
    recipe.dotenv_values=lambda path: values if path=='/home/boxes/rose/agents/.env' else {}
    return recipe

def fetch_receipt(recipe, sidecar_key, output):
    client,bucket,aes,_=recipe.connection()
    body=client.get_object(Bucket=bucket,Key=sidecar_key)['Body']
    try:
        wire=body.read(1024*1024)
        if body.read(1):raise RuntimeError('Receipt exceeds bounded size')
    finally:body.close()
    magic=b'ROSE-CLOSEOUT-RECEIPT-GCM-V1\n';offset=len(magic)
    if not wire.startswith(magic) or len(wire)<offset+28:raise RuntimeError('Invalid receipt envelope')
    plain=aes.decrypt(wire[offset:offset+12],wire[offset+12:],sidecar_key.encode())
    receipt=json.loads(plain)
    if receipt.get('bucket')!=bucket or receipt.get('receipt_sidecar_key')!=sidecar_key:
        raise RuntimeError('Receipt destination mismatch')
    target=Path(output);target.parent.mkdir(parents=True,exist_ok=True)
    with target.open('xb') as stream:stream.write(plain)
    os.chmod(target,0o600)
    return receipt

def main():
    os.umask(0o077);p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--recipe',required=True);p.add_argument('--config',action='append',required=True)
    p.add_argument('--escrow',required=True);p.add_argument('--key-fingerprint',required=True)
    sub=p.add_subparsers(dest='command',required=True)
    a=sub.add_parser('fetch-receipt');a.add_argument('--sidecar-key',required=True);a.add_argument('--output',required=True)
    for command in ('restore','verify'):
        a=sub.add_parser(command);a.add_argument('--receipt',required=True)
        if command=='restore':a.add_argument('--destination',required=True)
    args=p.parse_args();recipe=configured_recipe(args.recipe,args.config,args.escrow,args.key_fingerprint)
    if args.command=='fetch-receipt':
        receipt=fetch_receipt(recipe,args.sidecar_key,args.output)
        print(json.dumps({'receipt_authenticated':True,'files':receipt['files'],'output':args.output}))
    elif args.command=='restore':recipe.restore(args)
    else:
        client,_,aes,_=recipe.connection();receipt=json.loads(Path(args.receipt).read_text());recipe.verify(client,aes,receipt)
        print(json.dumps({'authenticated_original_files':receipt['files']}))
if __name__=='__main__':main()
