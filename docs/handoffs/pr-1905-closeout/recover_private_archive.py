"""Recover immutable PR1905 private archive snapshots into a new directory."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tarfile
import tempfile

import boto3
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from dotenv import dotenv_values

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--receipt', required=True, type=Path)
parser.add_argument('--target', required=True, type=Path)
args = parser.parse_args()
args.target.mkdir(parents=True, exist_ok=False, mode=0o700)
env = {**dotenv_values('back-end/.env'), **os.environ}
client = boto3.client('s3', endpoint_url='https://' + env['R2_ACCOUNT_ID'] + '.r2.cloudflarestorage.com', aws_access_key_id=env['R2_ACCESS_KEY_ID'], aws_secret_access_key=env['R2_SECRET_ACCESS_KEY'])
cipher = AESGCM(base64.b64decode(env['TRACE_ARCHIVE_ENCRYPTION_KEY_B64']))
seen = set()

def recover(receipt_bytes):
    receipt = json.loads(receipt_bytes)
    prefix = receipt['prefix']
    assert prefix.startswith('devbox-closeout-private/pr1905/') and prefix not in seen
    seen.add(prefix)
    bucket = receipt['bucket']
    previous = receipt.get('previous_receipt_key')
    if previous:
        previous_bytes = client.get_object(Bucket=bucket, Key=previous)['Body'].read()
        assert hashlib.sha256(previous_bytes).hexdigest() == receipt['previous_receipt_sha256']
        recover(previous_bytes)
    key = prefix + '/members.private.json.aesgcm'
    blob = client.get_object(Bucket=bucket, Key=key)['Body'].read()
    manifest_bytes = cipher.decrypt(blob[:12], blob[12:], key.encode())
    assert hashlib.sha256(manifest_bytes).hexdigest() == receipt['member_manifest_sha256']
    members = json.loads(manifest_bytes)
    folder = args.target / receipt['label']
    folder.mkdir(mode=0o700)
    (folder / 'receipt.json').write_bytes(receipt_bytes)
    (folder / 'members.private.json').write_bytes(manifest_bytes)
    digest = hashlib.sha256()
    verified = set()
    with tempfile.TemporaryFile() as archive:
        for part in receipt['parts']:
            blob = client.get_object(Bucket=bucket, Key=part['key'])['Body'].read()
            assert hashlib.sha256(blob).hexdigest() == part['sha256']
            raw = cipher.decrypt(blob[:12], blob[12:], part['key'].encode())
            assert len(raw) == part['plain_bytes']
            digest.update(raw)
            archive.write(raw)
        assert digest.hexdigest() == receipt['sha256']
        archive.seek(0)
        with tarfile.open(fileobj=archive, mode='r|gz') as tar:
            for entry in tar:
                name = PurePosixPath(entry.name)
                assert entry.isfile() and not name.is_absolute() and '..' not in name.parts
                assert entry.name in members and entry.name not in verified
                expected = members[entry.name]
                destination = folder.joinpath(*name.parts)
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                digest_member = hashlib.sha256()
                with destination.open('xb') as output:
                    os.chmod(destination, 0o600)
                    source = tar.extractfile(entry)
                    for block in iter(lambda: source.read(1024 * 1024), b''):
                        digest_member.update(block)
                        output.write(block)
                assert destination.stat().st_size == expected['bytes']
                assert digest_member.hexdigest() == expected['sha256']
                recorded_mtime = expected.get('mtime_ns', int(entry.mtime * 1_000_000_000))
                os.utime(destination, ns=(recorded_mtime, recorded_mtime))
                assert destination.stat().st_mtime_ns == recorded_mtime
                verified.add(entry.name)
    assert verified == set(members)
    print(receipt['label'], len(verified), 'authenticated members recovered')

recover(args.receipt.read_bytes())
print('Recovery complete; snapshots retain their original identities and clocks.')
