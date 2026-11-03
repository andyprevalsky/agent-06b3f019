#!/usr/bin/env python3
"""Preserve exact private task files in bounded AES-GCM frames in the trace R2 bucket.

Uses existing authoritative dotenv credentials and encryption key, never prints them.
Archive paths retain home-relative locations. Upload verifies unchanged source files,
then reads the complete object back, authenticating every frame and its stream hash.
Restore accepts a private receipt and an empty destination; it never overwrites files.
"""
import argparse
import base64
import gzip
import hashlib
import io
import json
import os
import struct
import tarfile
from pathlib import Path

import boto3
from botocore.config import Config
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from dotenv import dotenv_values

MAGIC = b"ROSE-PRIVATE-TAR-GCM-V1\n"
BLOCK = 8 * 1024 * 1024


def connection():
    values = {}
    for path in ("/home/boxes/rose/agents/.env", "/home/boxes/rose/back-end/.env"):
        values.update({k: v for k, v in dotenv_values(path).items() if v})
    required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
                "R2_BUCKET_TRACE_ARCHIVE", "TRACE_ARCHIVE_ENCRYPTION_KEY_B64")
    if any(not values.get(k) for k in required):
        raise RuntimeError("Required private archive configuration is absent")
    key = base64.b64decode(values["TRACE_ARCHIVE_ENCRYPTION_KEY_B64"], validate=True)
    if len(key) != 32:
        raise RuntimeError("Invalid existing encryption key length")
    client = boto3.client("s3", endpoint_url=f"https://{values['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                          aws_access_key_id=values["R2_ACCESS_KEY_ID"],
                          aws_secret_access_key=values["R2_SECRET_ACCESS_KEY"], region_name="auto",
                          config=Config(connect_timeout=15, read_timeout=120,
                                        retries={"max_attempts": 4, "mode": "standard"}))
    return client, values["R2_BUCKET_TRACE_ARCHIVE"], AESGCM(key), values.get("TRACE_ARCHIVE_KEY_ID")


class Writer:
    def __init__(self, client, bucket, key, aes):
        self.client, self.bucket, self.key, self.aes = client, bucket, key, aes
        self.upload = client.create_multipart_upload(Bucket=bucket, Key=key)["UploadId"]
        self.buffer = bytearray()
        self.parts = []
        self.wire_buffer = bytearray()
        self.plain_hash, self.cipher_hash = hashlib.sha256(), hashlib.sha256()
        self.stored_bytes = 0
        self.frames = 0

    def write(self, data):
        self.plain_hash.update(data)
        self.buffer.extend(data)
        while len(self.buffer) >= BLOCK:
            block = bytes(self.buffer[:BLOCK])
            del self.buffer[:BLOCK]
            self.emit(block)
        return len(data)

    def emit(self, block):
        nonce = os.urandom(12)
        aad = (self.key + ":" + str(self.frames)).encode()
        body = self.aes.encrypt(nonce, block, aad)
        packet = (MAGIC if self.frames == 0 else b"") + struct.pack(">I", len(body)) + nonce + body
        self.cipher_hash.update(packet)
        self.stored_bytes += len(packet)
        self.wire_buffer.extend(packet)
        while len(self.wire_buffer) >= BLOCK:
            part = bytes(self.wire_buffer[:BLOCK])
            del self.wire_buffer[:BLOCK]
            self.upload_part(part)
        self.frames += 1

    def upload_part(self, packet):
        number = len(self.parts) + 1
        etag = self.client.upload_part(Bucket=self.bucket, Key=self.key, UploadId=self.upload,
                                       PartNumber=number, Body=packet)["ETag"]
        self.parts.append({"PartNumber": number, "ETag": etag})
        if number % 32 == 0:
            print(json.dumps({"phase": "upload", "stored_bytes": self.stored_bytes}), flush=True)

    def finish(self):
        if self.buffer:
            self.emit(bytes(self.buffer))
            self.buffer.clear()
        if self.wire_buffer:
            self.upload_part(bytes(self.wire_buffer))
            self.wire_buffer.clear()
        self.client.complete_multipart_upload(Bucket=self.bucket, Key=self.key, UploadId=self.upload,
                                              MultipartUpload={"Parts": self.parts})

    def abort(self):
        self.client.abort_multipart_upload(Bucket=self.bucket, Key=self.key, UploadId=self.upload)


class HashReader:
    def __init__(self, file):
        self.file, self.digest = file, hashlib.sha256()

    def read(self, size=-1):
        data = self.file.read(size)
        self.digest.update(data)
        return data


def upload(args):
    client, bucket, aes, key_id = connection()
    listing = json.loads(Path(args.files).read_text())
    writer = Writer(client, bucket, args.key, aes)
    manifest = []
    try:
        with gzip.GzipFile(fileobj=writer, mode="wb", compresslevel=1, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|") as archive:
                for name in listing:
                    path = Path(name)
                    before = path.stat()
                    if not path.is_file() or path.is_symlink():
                        raise RuntimeError("Archive requires regular files: " + name)
                    info = archive.gettarinfo(str(path), arcname=str(path.relative_to("/home/boxes")))
                    with path.open("rb") as source:
                        reader = HashReader(source)
                        archive.addfile(info, reader)
                    after = path.stat()
                    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        raise RuntimeError("Source changed during capture: " + name)
                    manifest.append({"path": info.name, "size": before.st_size,
                                     "sha256": reader.digest.hexdigest()})
                manifest_bytes = json.dumps(manifest, sort_keys=True).encode()
                info = tarfile.TarInfo("MIGRATION_MANIFEST.json")
                info.size = len(manifest_bytes)
                info.mode = 0o600
                archive.addfile(info, io.BytesIO(manifest_bytes))
        writer.finish()
    except BaseException:
        writer.abort()
        raise
    receipt = {"format": MAGIC.decode().strip(), "bucket": bucket, "key": args.key,
               "encryption_key_id": key_id, "ciphertext_sha256": writer.cipher_hash.hexdigest(),
               "gzip_sha256": writer.plain_hash.hexdigest(), "stored_bytes": writer.stored_bytes,
               "frames": writer.frames, "files": len(manifest),
               "original_bytes": sum(f["size"] for f in manifest),
               "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest()}
    verify(client, aes, receipt)
    receipt["full_readback_verified"] = True
    Path(args.receipt).write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt), flush=True)


def frames(client, aes, receipt):
    body = client.get_object(Bucket=receipt["bucket"], Key=receipt["key"])["Body"]
    cipher_hash, plain_hash = hashlib.sha256(), hashlib.sha256()

    def read(size):
        data = body.read(size)
        if len(data) != size:
            raise RuntimeError("Truncated archive")
        cipher_hash.update(data)
        return data

    try:
        if read(len(MAGIC)) != MAGIC:
            raise RuntimeError("Unrecognized archive")
        for i in range(receipt["frames"]):
            length = struct.unpack(">I", read(4))[0]
            if length > BLOCK + 16:
                raise RuntimeError("Invalid frame length")
            nonce, encrypted = read(12), read(length)
            plain = aes.decrypt(nonce, encrypted, (receipt["key"] + ":" + str(i)).encode())
            plain_hash.update(plain)
            yield plain
        if body.read(1):
            raise RuntimeError("Trailing archive bytes")
        if cipher_hash.hexdigest() != receipt["ciphertext_sha256"]:
            raise RuntimeError("Ciphertext digest mismatch")
        if plain_hash.hexdigest() != receipt["gzip_sha256"]:
            raise RuntimeError("Compressed stream digest mismatch")
    finally:
        body.close()


def verify(client, aes, receipt):
    observed = {}
    manifest_bytes = None
    with io.BufferedReader(FrameReader(frames(client, aes, receipt))) as stream:
        with tarfile.open(fileobj=stream, mode="r|gz") as archive:
            for info in archive:
                if not info.isfile():
                    raise RuntimeError("Unexpected non-file archive member")
                source = archive.extractfile(info)
                if info.name == "MIGRATION_MANIFEST.json":
                    manifest_bytes = source.read()
                    continue
                digest = hashlib.sha256()
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
                observed[info.name] = {"size": info.size, "sha256": digest.hexdigest()}
        while stream.read(1024 * 1024):
            pass
    if manifest_bytes is None or hashlib.sha256(manifest_bytes).hexdigest() != receipt["manifest_sha256"]:
        raise RuntimeError("Remote manifest mismatch")
    expected = {item["path"]: {"size": item["size"], "sha256": item["sha256"]}
                for item in json.loads(manifest_bytes)}
    if observed != expected or len(observed) != receipt["files"]:
        raise RuntimeError("Remote archive file digest mismatch")


class FrameReader(io.RawIOBase):
    def __init__(self, chunks):
        self.chunks, self.buffer = iter(chunks), bytearray()

    def readable(self):
        return True

    def readinto(self, destination):
        while not self.buffer:
            try:
                self.buffer.extend(next(self.chunks))
            except StopIteration:
                return 0
        count = min(len(destination), len(self.buffer))
        destination[:count] = self.buffer[:count]
        del self.buffer[:count]
        return count


def restore(args):
    client, _, aes, _ = connection()
    receipt = json.loads(Path(args.receipt).read_text())
    destination = Path(args.destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise RuntimeError("Restore destination must be empty")
    restored = {}
    with io.BufferedReader(FrameReader(frames(client, aes, receipt))) as stream:
        with tarfile.open(fileobj=stream, mode="r|gz") as archive:
            for info in archive:
                target = (destination / info.name).resolve()
                if not target.is_relative_to(destination) or not info.isfile():
                    raise RuntimeError("Unsafe archive member")
                source = archive.extractfile(info)
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                with target.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)
                        digest.update(chunk)
                os.chmod(target, info.mode)
                restored[info.name] = {"sha256": digest.hexdigest(), "size": info.size}
        while stream.read(1024 * 1024):
            pass  # Drain to authenticate the final frame and stream hashes.
    manifest_bytes = (destination / "MIGRATION_MANIFEST.json").read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != receipt["manifest_sha256"]:
        raise RuntimeError("Manifest digest mismatch")
    for item in json.loads(manifest_bytes):
        if restored.get(item["path"]) != {"sha256": item["sha256"], "size": item["size"]}:
            raise RuntimeError("Restored file digest mismatch")
    print(json.dumps({"restored_files": receipt["files"], "destination": str(destination)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    push = commands.add_parser("upload")
    push.add_argument("--files", required=True)
    push.add_argument("--key", required=True)
    push.add_argument("--receipt", required=True)
    pull = commands.add_parser("restore")
    pull.add_argument("--receipt", required=True)
    pull.add_argument("--destination", required=True)
    check = commands.add_parser("verify")
    check.add_argument("--receipt", required=True)
    args = parser.parse_args()
    if args.command == "verify":
        client, _, aes, _ = connection()
        receipt = json.loads(Path(args.receipt).read_text())
        verify(client, aes, receipt)
        print(json.dumps({"authenticated_original_files": receipt["files"], "key": receipt["key"]}))
    else:
        (upload if args.command == "upload" else restore)(args)


if __name__ == "__main__":
    main()
