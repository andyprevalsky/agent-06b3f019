#!/usr/bin/env python3
"""Private, encrypted devbox closeout archive in the trace-archive R2 bucket (PR #1775 closeout; copied from the PR #1778 closeout tool).

pack     tar.gz the given paths, split into 64 MiB parts, encrypt each part with AES-256-GCM
         (nonce(12) || ciphertext, aad = object key) under TRACE_ARCHIVE_ENCRYPTION_KEY_B64, upload
         to devbox-closeout-private/<name>/part-NNNNN, then verify by downloading and decrypting
         every part and comparing the reassembled sha256. Writes a JSON receipt.
verify   re-download and re-check an archive from its receipt.
restore  download, decrypt and untar an archive into a destination directory.
head     confirm an existing archive object is present (size and etag).

Credentials: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_TRACE_ARCHIVE and
TRACE_ARCHIVE_ENCRYPTION_KEY_B64 from back-end/.env (the same key as the trace archive). Run with the
agents venv (boto3, cryptography, python-dotenv).
"""
import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

PREFIX = 'devbox-closeout-private'
CHUNK = 64 * 1024 * 1024


def connection(env_file: str):
    import boto3
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from dotenv import dotenv_values
    env = dotenv_values(env_file)
    client = boto3.client('s3', endpoint_url=f"https://{env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                          aws_access_key_id=env['R2_ACCESS_KEY_ID'],
                          aws_secret_access_key=env['R2_SECRET_ACCESS_KEY'], region_name='auto')
    key = base64.b64decode(env['TRACE_ARCHIVE_ENCRYPTION_KEY_B64'], validate=True)
    if len(key) != 32:
        raise SystemExit('TRACE_ARCHIVE_ENCRYPTION_KEY_B64 is not a 256-bit key')
    return client, env['R2_BUCKET_TRACE_ARCHIVE'], AESGCM(key)


def parts_of(receipt: dict) -> list[str]:
    return [f"{receipt['key_prefix']}part-{i:05d}" for i in range(receipt['parts'])]


def download(client, bucket: str, aes, receipt: dict, sink) -> str:
    digest = hashlib.sha256()
    for key in parts_of(receipt):
        wire = client.get_object(Bucket=bucket, Key=key)['Body'].read()
        plain = aes.decrypt(wire[:12], wire[12:], key.encode())
        digest.update(plain)
        sink(plain)
    return digest.hexdigest()


def pack(args) -> int:
    client, bucket, aes = connection(args.env)
    prefix = f'{PREFIX}/{args.name}/'
    with tempfile.TemporaryDirectory(dir=args.tmp) as tmp:
        archive = Path(tmp) / 'archive.tar.gz'
        members = [str(Path(p).resolve()) for p in args.paths]
        subprocess.run(['tar', '-czf', str(archive), '--absolute-names', *members], check=True)
        digest, size, parts = hashlib.sha256(), archive.stat().st_size, 0
        with archive.open('rb') as stream:
            while chunk := stream.read(CHUNK):
                digest.update(chunk)
                key = f'{prefix}part-{parts:05d}'
                nonce = os.urandom(12)
                client.put_object(Bucket=bucket, Key=key, Body=nonce + aes.encrypt(nonce, chunk, key.encode()))
                parts += 1
        listing = subprocess.run(['tar', '-tzf', str(archive)], check=True, capture_output=True, text=True).stdout
        receipt = {'name': args.name, 'key_prefix': prefix, 'bucket_env': 'R2_BUCKET_TRACE_ARCHIVE',
                   'archive_sha256': digest.hexdigest(), 'archive_size_bytes': size, 'parts': parts,
                   'chunk_size': CHUNK, 'members': members,
                   'files': sum(1 for line in listing.splitlines() if line and not line.endswith('/')),
                   'cipher': 'AES-256-GCM nonce(12)||ciphertext, aad=object key',
                   'key_location': 'TRACE_ARCHIVE_ENCRYPTION_KEY_B64 (back-end/.env; same key as the trace archive)',
                   'restore': 'closeout_archive.py restore --receipt <receipt> --destination <dir>'}
    readback = download(client, bucket, aes, receipt, lambda _plain: None)
    if readback != receipt['archive_sha256']:
        raise SystemExit(f'readback sha256 {readback} != uploaded {receipt["archive_sha256"]}')
    receipt['verified'] = 'every part downloaded, decrypted and the reassembled sha256 matched after upload'
    Path(args.receipt).write_text(json.dumps(receipt, indent=1) + '\n')
    print(json.dumps({k: receipt[k] for k in ('name', 'archive_sha256', 'archive_size_bytes', 'parts', 'files')}))
    return 0


def verify(args) -> int:
    client, bucket, aes = connection(args.env)
    receipt = json.loads(Path(args.receipt).read_text())
    readback = download(client, bucket, aes, receipt, lambda _plain: None)
    ok = readback == receipt['archive_sha256']
    print(json.dumps({'name': receipt['name'], 'verified': ok, 'sha256': readback}))
    return 0 if ok else 1


def restore(args) -> int:
    client, bucket, aes = connection(args.env)
    receipt = json.loads(Path(args.receipt).read_text())
    dest = Path(args.destination)
    dest.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=args.tmp, suffix='.tar.gz') as out:
        readback = download(client, bucket, aes, receipt, out.write)
        out.flush()
        if readback != receipt['archive_sha256']:
            raise SystemExit('archive sha256 mismatch; nothing extracted')
        subprocess.run(['tar', '-xzf', out.name, '-C', str(dest)], check=True)
    print(json.dumps({'name': receipt['name'], 'restored_to': str(dest)}))
    return 0


def head(args) -> int:
    client, bucket, _ = connection(args.env)
    meta = client.head_object(Bucket=bucket, Key=args.key)
    print(json.dumps({'key': args.key, 'size': meta['ContentLength'], 'etag': meta['ETag']}))
    return 0


def main(argv=None) -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--env', default='back-end/.env')
    parser.add_argument('--tmp', default='/var/tmp')
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('pack')
    p.add_argument('--name', required=True)
    p.add_argument('--receipt', required=True)
    p.add_argument('paths', nargs='+')
    for name in ('verify', 'restore'):
        p = sub.add_parser(name)
        p.add_argument('--receipt', required=True)
        if name == 'restore':
            p.add_argument('--destination', required=True)
    p = sub.add_parser('head')
    p.add_argument('--key', required=True)
    args = parser.parse_args(argv)
    return {'pack': pack, 'verify': verify, 'restore': restore, 'head': head}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
