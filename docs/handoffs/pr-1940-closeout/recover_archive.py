"""Read a verified PR #1940 private archive into new private paths; never overwrite a checkout."""
import argparse
import base64
import hashlib
import json
import os
import shutil
import tarfile
from pathlib import Path, PurePosixPath

import boto3
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from dotenv import dotenv_values

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--catalog', type=Path, default=Path(__file__).with_name('archive-index.json'))
parser.add_argument('--archive', required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--extract', type=Path)
args = parser.parse_args()
catalog = json.loads(args.catalog.read_text())
receipt = catalog['archives'][args.archive]
root = Path(__file__).resolve().parents[3]
env = {**dotenv_values(root / 'agents/.env'), **dotenv_values(root / 'back-end/.env'), **os.environ}
key = base64.b64decode(env[catalog['key_env']])
assert hashlib.sha256(key).hexdigest() == catalog['key_fingerprint_sha256'], 'wrong recovery key'
cipher = AESGCM(key)
client = boto3.client('s3', endpoint_url='https://' + env['R2_ACCOUNT_ID'] + '.r2.cloudflarestorage.com',
                      aws_access_key_id=env['R2_ACCESS_KEY_ID'], aws_secret_access_key=env['R2_SECRET_ACCESS_KEY'])
parts = receipt.get('parts') or [{'key': receipt['key'], 'sha256': receipt['ciphertext_sha256']}]
args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
digest = hashlib.sha256()
with args.output.open('xb') as destination:
    os.chmod(args.output, 0o600)
    for part in parts:
        blob = client.get_object(Bucket=env[catalog['bucket_env']], Key=part['key'])['Body'].read()
        assert hashlib.sha256(blob).hexdigest() == part['sha256'], 'ciphertext hash mismatch'
        raw = cipher.decrypt(blob[:12], blob[12:], part['key'].encode())
        if 'plain_bytes' in part:
            assert len(raw) == part['plain_bytes']
        digest.update(raw)
        destination.write(raw)
assert digest.hexdigest() == receipt['sha256'], 'plaintext hash mismatch'
if args.extract:
    assert 'TAR' in receipt['format'], 'Git bundles are not tar archives'
    assert not args.extract.exists(), 'extraction requires a new empty path'
    args.extract.mkdir(parents=True, mode=0o700)
    links = []
    with tarfile.open(args.output, 'r|gz') as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            assert not name.is_absolute() and '..' not in name.parts, 'unsafe archive path'
            target = args.extract.joinpath(*name.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with target.open('xb') as destination:
                    os.chmod(target, 0o600)
                    shutil.copyfileobj(archive.extractfile(member), destination)
            else:
                links.append({'name': member.name, 'linkname': member.linkname, 'type': repr(member.type)})
    (args.extract / 'LINK-METADATA.private.json').write_text(json.dumps(links, indent=2) + '\n')
print(json.dumps({'archive': args.archive, 'sha256': digest.hexdigest(), 'authenticated': True,
                  'output': str(args.output), 'extracted': str(args.extract) if args.extract else None}))
