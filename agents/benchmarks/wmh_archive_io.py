"""Lightweight canonical archive redaction and durable JSON publication, no model build imports."""

from __future__ import annotations

import json
import os
import tempfile
from functools import lru_cache

from exp.common.core.artifacts import SecretBoundaryError, assert_secret_free, redact_secret_json


@lru_cache(maxsize=4096)
def _credential_field(key):
    try:
        assert_secret_free({key: None})
    except SecretBoundaryError:
        return True
    return False


def redact_archive(value):
    """Use upstream's secret rules, also removing its forbidden credential fields."""
    redacted, total = redact_secret_json(value)

    def fields(item):
        nonlocal total
        if isinstance(item, dict):
            result = {}
            for key, child in item.items():
                if _credential_field(key):
                    total += 1
                else:
                    result[key] = fields(child)
            return result
        if isinstance(item, list):
            return [fields(child) for child in item]
        if isinstance(item, str) and item.lstrip().startswith(("{", "[")):
            # OTel arguments, observations and snapshots contain encoded JSON.
            try:
                decoded = json.loads(item)
            except ValueError:
                return item
            if isinstance(decoded, (dict, list)):
                safe, count = redact_archive(decoded)
                total += count
                if count:
                    return json.dumps(safe, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return item

    redacted = fields(redacted)
    assert_secret_free(redacted)
    return redacted, total


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=path.name + ".", delete=False) as temporary:
        name = temporary.name
        try:
            json.dump(payload, temporary, indent=2)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
            os.replace(name, path)
        finally:
            if os.path.exists(name):
                os.unlink(name)
