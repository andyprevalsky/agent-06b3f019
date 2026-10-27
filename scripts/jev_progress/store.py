"""Private encrypted, content-addressed research artifacts in the trace bucket."""
import base64
import gzip
import hashlib
import json
import os
from core import credential

PREFIX = 'jev-research/v1/'


class Store:
    def __init__(self):
        import boto3
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        self.client = boto3.client('s3', endpoint_url='https://' + credential('R2_ACCOUNT_ID') + '.r2.cloudflarestorage.com',
                                   aws_access_key_id=credential('R2_ACCESS_KEY_ID'),
                                   aws_secret_access_key=credential('R2_SECRET_ACCESS_KEY'))
        self.bucket = credential('R2_BUCKET_TRACE_ARCHIVE')
        self.cipher = AESGCM(base64.b64decode(credential('TRACE_ARCHIVE_ENCRYPTION_KEY_B64')))

    def put(self, value):
        raw = json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
        key = PREFIX + 'objects/' + hashlib.sha256(raw).hexdigest()
        nonce = os.urandom(12)
        blob = nonce + self.cipher.encrypt(nonce, gzip.compress(raw), key.encode())
        self.client.put_object(Bucket=self.bucket, Key=key, Body=blob)
        # Verify both roundtrip decryption and content digest before returning.
        if self.get(key) != value:
            raise RuntimeError('Research artifact did not roundtrip')
        return key

    def get(self, key):
        if not key.startswith(PREFIX + 'objects/'):
            raise ValueError('Invalid research object key')
        blob = self.client.get_object(Bucket=self.bucket, Key=key)['Body'].read()
        raw = gzip.decompress(self.cipher.decrypt(blob[:12], blob[12:], key.encode()))
        if hashlib.sha256(raw).hexdigest() != key.rsplit('/', 1)[1]:
            raise ValueError('Research artifact digest mismatch')
        return json.loads(raw)

    def head(self):
        result = self.client.get_object(Bucket=self.bucket, Key=PREFIX + 'head.json')
        return json.loads(result['Body'].read()), result['ETag']

    def advance(self, state, previous_etag=None):
        key = self.put(state)
        condition = {'IfMatch': previous_etag} if previous_etag else {'IfNoneMatch': '*'}
        self.client.put_object(Bucket=self.bucket, Key=PREFIX + 'head.json',
                               Body=json.dumps({'state': key}).encode(), **condition)
        return key

    def receipt(self, run_id, value):
        key = self.put(value)
        self.client.put_object(Bucket=self.bucket, Key=PREFIX + 'receipts/' + run_id + '.json',
                               Body=json.dumps({'artifact': key}).encode(), IfNoneMatch='*')
        return key
