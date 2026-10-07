#!/usr/bin/env python3
"""Verify the published registry handoff and restore only hash-proven manifests."""

import argparse
import base64
import copy
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
IMAGE = re.compile(r"registry\.fly\.io/([a-z0-9-]+):(cloudbench-warm-\d{8}-\d{6}-\d+)\Z")
ACCEPT = ", ".join(
    (
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
    )
)


class HandoffError(Exception):
    def __init__(self, message, retryable=False):
        super().__init__(message)
        self.retryable = retryable


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Registry credentials must never follow a redirect to another origin.
        return None


def ordered_manifest(value, kind="manifest"):
    """Restore OCI struct field ordering without discarding unknown fields."""
    if not isinstance(value, dict):
        raise HandoffError("Image metadata does not contain a manifest object")
    orders = {
        "manifest": (
            "schemaVersion",
            "mediaType",
            "artifactType",
            "config",
            "layers",
            "manifests",
            "subject",
            "annotations",
        ),
        "descriptor": ("mediaType", "digest", "size", "urls", "annotations", "data", "platform", "artifactType"),
        "platform": ("architecture", "os", "os.version", "os.features", "variant", "features"),
    }
    keys = list(orders[kind]) + sorted(set(value) - set(orders[kind]))
    result = {}
    for key in keys:
        if key not in value:
            continue
        item = value[key]
        if key in ("config", "subject"):
            item = ordered_manifest(item, "descriptor")
        elif key in ("layers", "manifests"):
            item = [ordered_manifest(entry, "descriptor") for entry in item]
        elif key == "platform":
            item = ordered_manifest(item, "platform")
        elif key == "annotations":
            item = dict(sorted(item.items()))
        result[key] = item
    return result


def manifest_bytes(metadata, expected):
    """Accept reconstructed bytes only when their SHA is the original SHA."""
    if not DIGEST.fullmatch(expected or ""):
        raise HandoffError("Image metadata has no valid manifest digest")
    candidates = []
    if isinstance(metadata, str):
        candidates.append(metadata.encode())
        metadata = json.loads(metadata)
    original = ordered_manifest(metadata)
    variants = [original]
    if "fly_builder_id" in original.get("annotations", {}):
        without_metadata = copy.deepcopy(original)
        del without_metadata["annotations"]["fly_builder_id"]
        if not without_metadata["annotations"]:
            del without_metadata["annotations"]
        variants.append(without_metadata)
    # BuildKit uses Go json.MarshalIndent; classic publishers can use compact JSON.
    for variant in variants:
        for indent in (2, None):
            encoded = json.dumps(variant, indent=indent, separators=None if indent else (",", ":"), ensure_ascii=False)
            for character, escaped in (
                ("&", "\\u0026"),
                ("<", "\\u003c"),
                (">", "\\u003e"),
                ("\u2028", "\\u2028"),
                ("\u2029", "\\u2029"),
            ):
                encoded = encoded.replace(character, escaped)
            candidates.append(encoded.encode())
    for candidate in candidates:
        if "sha256:" + hashlib.sha256(candidate).hexdigest() == expected:
            return candidate
    raise HandoffError("Stored metadata cannot reproduce the original manifest digest")


class RegistryHandoff:
    def __init__(
        self,
        token,
        out_dir,
        selected_app,
        registry_origin="https://registry.fly.io",
        graphql_origin="https://api.fly.io/graphql",
        sleep=time.sleep,
        clock=time.monotonic,
    ):
        self.token = token
        self.out_dir = Path(out_dir)
        self.out_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.registry_origin = registry_origin.rstrip("/")
        self.graphql_origin = graphql_origin
        self.selected_app = selected_app
        self.sleep = sleep
        self.clock = clock
        self.opener = urllib.request.build_opener(NoRedirect())
        self.sequence = 0

    def request(self, method, url, body=None, media_type=None, graphql=False):
        self.sequence += 1
        auth = "Bearer " + self.token if graphql else "Basic " + base64.b64encode(("x:" + self.token).encode()).decode()
        headers = {"Authorization": auth, "Accept": ACCEPT}
        if media_type:
            headers["Content-Type"] = media_type
        try:
            request = urllib.request.Request(url, data=body, headers=headers, method=method)
            try:
                response = self.opener.open(request, timeout=30)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status = response.status
                data = response.read(1024 * 1024 + 1)
                response_headers = response.headers
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise HandoffError("Registry handoff transport observation failed", retryable=True) from error
        artifact = self.out_dir / f"{self.sequence:02d}-{method.lower()}.private.body"
        with artifact.open("xb") as output:
            output.write(data)
        artifact.chmod(0o600)
        if len(data) > 1024 * 1024:
            raise HandoffError("Registry manifest response exceeds the metadata bound")
        summary = {
            "method": method,
            "status": status,
            "body_sha256": hashlib.sha256(data).hexdigest(),
            "body_size": len(data),
            "request_id": response_headers.get("Fly-Request-Id"),
        }
        path = artifact.with_suffix(".safe.json")
        path.write_text(json.dumps(summary) + "\n")
        path.chmod(0o600)
        if status in (408, 429) or status >= 500:
            raise HandoffError(f"Registry handoff HTTP {status}", retryable=True)
        if status in (401, 403):
            raise HandoffError(f"Registry handoff HTTP {status}")
        return status, data, response_headers

    def registry_get(self, app, ref):
        return self.request("GET", f"{self.registry_origin}/v2/{app}/manifests/{ref}")

    def cached_manifest(self, app, image, expected):
        query = (
            "query($appName:String!,$imageRef:String!){app(name:$appName){image(ref:$imageRef){digest ref manifest}}}"
        )
        body = json.dumps({"query": query, "variables": {"appName": app, "imageRef": image}}).encode()
        status, raw, _ = self.request("POST", self.graphql_origin, body, "application/json", graphql=True)
        if status != 200:
            raise HandoffError(f"Image metadata HTTP {status}")
        data = json.loads(raw)
        app_data = data.get("data") if isinstance(data, dict) else None
        app_metadata = app_data.get("app") if isinstance(app_data, dict) else None
        image_metadata = app_metadata.get("image") if isinstance(app_metadata, dict) else None
        if (
            not isinstance(data, dict)
            or data.get("errors")
            or not isinstance(image_metadata, dict)
            or not image_metadata
        ):
            raise HandoffError("Exact published image metadata is unavailable")
        digest = image_metadata.get("digest")
        if expected and digest != expected:
            raise HandoffError("Image metadata digest differs from the published output")
        raw_manifest = manifest_bytes(image_metadata.get("manifest"), digest)
        media_type = json.loads(raw_manifest).get("mediaType")
        if media_type not in ACCEPT.split(", "):
            raise HandoffError("Published manifest has an unsupported media type")
        return raw_manifest, digest, media_type

    def verify(self, image, expected_digest=None):
        match = IMAGE.fullmatch(image)
        if not match or match.group(1) != self.selected_app or self.selected_app == "navi-whisper-lux":
            raise HandoffError("Registry handoff requires the exact owned benchmark image tag")
        if expected_digest and not DIGEST.fullmatch(expected_digest):
            raise HandoffError("Published output has an invalid digest")
        app, tag = match.groups()
        recovered = None
        republished = False
        republication_attempted = False
        deadline = self.clock() + 180
        attempt = 0
        while True:
            attempt += 1
            try:
                status, raw, headers = self.registry_get(app, tag)
                if status == 404 and not republication_attempted:
                    if not expected_digest:
                        raise HandoffError("Original published output digest is required before republication")
                    if recovered is None:
                        recovered = self.cached_manifest(app, image, expected_digest)
                    manifest, expected_digest, media_type = recovered
                    republication_attempted = True
                    status, rejected, put_headers = self.request(
                        "PUT", f"{self.registry_origin}/v2/{app}/manifests/{tag}", manifest, media_type
                    )
                    if status != 201:
                        try:
                            rejection = json.loads(rejected) if status == 400 else None
                        except ValueError:
                            rejection = None
                        errors = rejection.get("errors") if isinstance(rejection, dict) else None
                        missing_blobs_pending = (
                            isinstance(errors, list)
                            and bool(errors)
                            and all(
                                isinstance(error, dict) and error.get("code") == "MANIFEST_BLOB_UNKNOWN"
                                for error in errors
                            )
                        )
                        raise HandoffError(
                            f"Exact manifest republication HTTP {status}", retryable=missing_blobs_pending
                        )
                    if put_headers.get("Docker-Content-Digest") not in (None, expected_digest):
                        raise HandoffError("Registry acknowledged a different manifest digest")
                    republished = True
                    status, raw, headers = self.registry_get(app, tag)
                if status != 200:
                    raise HandoffError(f"Exact tag manifest HTTP {status}", retryable=status == 404)
                digest = "sha256:" + hashlib.sha256(raw).hexdigest()
                if headers.get("Docker-Content-Digest") not in (None, digest) or (
                    expected_digest and digest != expected_digest
                ):
                    raise HandoffError("Registry tag manifest does not match the published digest")
                status, by_digest, digest_headers = self.registry_get(app, digest)
                if status != 200:
                    raise HandoffError(f"Exact digest manifest HTTP {status}", retryable=status == 404)
                if by_digest != raw or digest_headers.get("Docker-Content-Digest") not in (None, digest):
                    raise HandoffError("Registry digest manifest differs from its tag")
                return {
                    "registry_handoff_verified": True,
                    "published_digest": digest,
                    "published_image_ref": image + "@" + digest,
                    "manifest_republished": republished,
                    "registry_handoff_attempts": attempt,
                }
            except HandoffError as error:
                if not error.retryable or self.clock() >= deadline:
                    raise
                self.sleep(min(5, max(0, deadline - self.clock())))


def publisher_digest(log, image):
    text = Path(log).read_text(errors="replace")
    pushed = re.findall(r"pushing manifest for " + re.escape(image) + r"@(sha256:[0-9a-f]{64})[^\n]*done", text)
    if pushed:
        return pushed[-1]
    digests = re.findall(r"\bdigest:\s*(sha256:[0-9a-f]{64})", text)
    return digests[-1] if digests else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client", required=True)
    parser.add_argument("--app", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--out-file", required=True)
    parser.add_argument("--publisher-log")
    parser.add_argument("--expected-digest")
    args = parser.parse_args()
    os.umask(0o077)
    target = Path(args.out_file)
    receipt = {"registry_handoff_verified": False}
    try:
        match = IMAGE.fullmatch(args.image)
        if not match or match.group(1) != args.app or args.app == "navi-whisper-lux":
            raise HandoffError("Registry handoff requires the exact owned benchmark image tag")
        expected = args.expected_digest or (
            publisher_digest(args.publisher_log, args.image) if args.publisher_log else None
        )
        result = subprocess.run(
            [args.client, "auth", "token", "--json", "--quiet"], capture_output=True, text=True, timeout=45
        )
        if result.returncode != 0:
            raise HandoffError("Selected Fly session could not supply registry authentication")
        auth_data = json.loads(result.stdout)
        token = auth_data.get("token") if isinstance(auth_data, dict) else None
        if not isinstance(token, str) or not token:
            raise HandoffError("Selected Fly session returned no registry authentication")
        private_dir = tempfile.mkdtemp(prefix=target.name + ".", suffix=".private", dir=target.parent)
        receipt = RegistryHandoff(token, private_dir, args.app).verify(args.image, expected)
    except (HandoffError, ValueError, OSError, subprocess.SubprocessError) as error:
        # Never include credential-bearing subprocess output or response bodies.
        receipt["registry_handoff_error"] = (
            str(error) if isinstance(error, HandoffError) else "Registry handoff metadata could not be verified"
        )
    target.write_text(json.dumps(receipt) + "\n")
    target.chmod(0o600)
    if not receipt["registry_handoff_verified"]:
        print(receipt["registry_handoff_error"])
        return 74
    print(
        "Exact published registry manifest verified"
        + (" after same-output republication" if receipt["manifest_republished"] else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
