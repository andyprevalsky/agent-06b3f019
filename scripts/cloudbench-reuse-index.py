#!/usr/bin/env python3
"""Build once from a fully validated request; workers hash all bytes, parse one row.

The caller must bind index_sha to immutable launch authority. An index is not a
replacement for the parent's whole-request validator and grants no native effects.
"""

import hashlib
import json
import os
import re
import stat
from contextlib import contextmanager
from pathlib import Path

REQUEST_LIMIT = 16 * 1024 * 1024
INDEX_LIMIT = 1024 * 1024
CHUNK = 64 * 1024
FORMAT = "cloudbench-reuse-index-v1"
TASK_REF = "1387ae608e7cfb8e3f0a876daae92093f503b465"
TASK_NAMES_SHA = "660873a9e02c6c5682a98e9a00dd0133c394a16dcdefd726bcb0a8987f1b59f5"


def need(condition, message):
    if not condition:
        raise ValueError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    # Matches original600-runner.save; ASCII makes character offsets byte offsets.
    return (
        json.dumps(value, sort_keys=True, allow_nan=False, ensure_ascii=True) + "\n"
    ).encode("ascii")


def pairs(items):
    result = {}
    for key, value in items:
        need(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def invalid_constant(value):
    raise ValueError("nonfinite JSON value")


DECODER = json.JSONDecoder(object_pairs_hook=pairs, parse_constant=invalid_constant)


def strict(raw):
    value = DECODER.decode(raw.decode("ascii"))
    need(encoded(value) == raw, "noncanonical ASCII JSON")
    return value


def hex_digest(value):
    return isinstance(value, str) and re.fullmatch("[0-9a-f]{64}", value) is not None


def check_header(header):
    need(
        isinstance(header, dict)
        and set(header)
        == {
            "schema",
            "storage_mode",
            "app",
            "harness_ref",
            "task_ref",
            "cohort",
            "task_names",
            "archives",
            "image_ref",
        },
        "invalid index header",
    )
    need(
        header["schema"] == "cloudbench-archived-reuse-v1"
        and header["storage_mode"] == "retained-volume-fresh-generation"
        and header["app"] == "navi-whisper-lux-bench",
        "foreign request header",
    )
    need(
        isinstance(header["harness_ref"], str)
        and re.fullmatch("[0-9a-f]{40}", header["harness_ref"])
        and header["task_ref"] == TASK_REF
        and isinstance(header["cohort"], str)
        and re.fullmatch("[0-9a-f]{32}", header["cohort"]),
        "invalid source/cohort pins",
    )
    tasks = header["task_names"]
    need(
        isinstance(tasks, list)
        and len(tasks) == 200
        and all(isinstance(t, str) for t in tasks)
        and len(set(tasks)) == 200
        and digest(("\n".join(tasks) + "\n").encode()) == TASK_NAMES_SHA,
        "original task order changed",
    )
    archives = header["archives"]
    need(
        isinstance(archives, list)
        and archives
        and all(
            isinstance(a, dict)
            and set(a) == {"archive_sha256"}
            and hex_digest(a["archive_sha256"])
            for a in archives
        ),
        "invalid ordered archives",
    )
    need(
        isinstance(header["image_ref"], str)
        and "@sha256:" in header["image_ref"]
        and hex_digest(header["image_ref"].rsplit("@sha256:", 1)[1]),
        "invalid immutable image",
    )


def spans(text):
    """Locate candidate values with JSONDecoder, never by matching row substrings."""
    pos = 1
    found = None
    while True:
        while text[pos].isspace():
            pos += 1
        if text[pos] == "}":
            break
        key, pos = DECODER.raw_decode(text, pos)
        while text[pos].isspace():
            pos += 1
        need(text[pos] == ":", "invalid top-level separator")
        pos += 1
        while text[pos].isspace():
            pos += 1
        if key == "candidates":
            need(found is None and text[pos] == "[", "invalid candidate array")
            found = []
            pos += 1
            while True:
                while text[pos].isspace():
                    pos += 1
                if text[pos] == "]":
                    pos += 1
                    break
                start = pos
                row, pos = DECODER.raw_decode(text, pos)
                found.append((start, pos - start, row))
                while text[pos].isspace():
                    pos += 1
                if text[pos] == ",":
                    pos += 1
                else:
                    need(text[pos] == "]", "invalid candidate delimiter")
            # The next top-level delimiter is handled below.
        else:
            _, pos = DECODER.raw_decode(text, pos)
        while text[pos].isspace():
            pos += 1
        if text[pos] == ",":
            pos += 1
        else:
            need(text[pos] == "}", "invalid top-level delimiter")
    need(found is not None, "candidate array absent")
    return found


def build(raw, expected_sha, expected_ref, validate_request):
    need(
        isinstance(raw, bytes) and 0 < len(raw) < REQUEST_LIMIT,
        "request size outside original bound",
    )
    need(
        hex_digest(expected_sha) and digest(raw) == expected_sha,
        "request digest changed",
    )
    value = strict(raw)
    need(isinstance(value, dict), "request must be object")
    validated = validate_request(value, expected_ref)
    need(validated == value and encoded(value) == raw, "validator changed request")
    header = {
        key: value[key]
        for key in (
            "schema",
            "storage_mode",
            "app",
            "harness_ref",
            "task_ref",
            "cohort",
            "task_names",
            "image_ref",
        )
    }
    header["archives"] = [
        {"archive_sha256": a["archive_sha256"]} for a in value["archives"]
    ]
    check_header(header)
    need(header["harness_ref"] == expected_ref, "source pin changed")
    located = spans(raw.decode("ascii"))
    need(
        1 <= len(located) <= 600 and len(located) == len(value["candidates"]),
        "candidate count invalid",
    )
    entries = []
    for index, (offset, length, selected) in enumerate(located):
        need(
            selected == value["candidates"][index],
            "candidate span differs from validated row",
        )
        entries.append(
            {
                "offset": offset,
                "length": length,
                "sha256": digest(raw[offset : offset + length]),
            }
        )
    result = encoded(
        {
            "format": FORMAT,
            "request_sha256": expected_sha,
            "request_bytes": len(raw),
            "header": header,
            "count": len(entries),
            "entries": entries,
        }
    )
    need(len(result) < INDEX_LIMIT, "index exceeds private metadata bound")
    return result


def fingerprint(info):
    return tuple(
        getattr(info, key)
        for key in (
            "st_dev",
            "st_ino",
            "st_size",
            "st_mode",
            "st_uid",
            "st_nlink",
            "st_mtime_ns",
            "st_ctime_ns",
        )
    )


@contextmanager
def opened(path, limit):
    path = Path(path).absolute()
    need(path.resolve(strict=True) == path, "physical private path required")
    with os.fdopen(
        os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb"
    ) as stream:
        before = os.fstat(stream.fileno())
        need(
            stat.S_ISREG(before.st_mode)
            and before.st_uid == os.geteuid()
            and before.st_nlink == 1
            and not before.st_mode & 0o077
            and 0 < before.st_size < limit,
            "private bounded regular file required",
        )
        yield stream, before.st_size
        need(
            fingerprint(before)
            == fingerprint(os.fstat(stream.fileno()))
            == fingerprint(path.stat(follow_symlinks=False)),
            "private input changed during read",
        )


def check_index(value, request_sha, size):
    need(
        isinstance(value, dict)
        and set(value)
        == {"format", "request_sha256", "request_bytes", "header", "count", "entries"},
        "invalid index shape",
    )
    need(
        value["format"] == FORMAT
        and value["request_sha256"] == request_sha
        and type(value["request_bytes"]) is int
        and value["request_bytes"] == size,
        "index request binding changed",
    )
    check_header(value["header"])
    entries = value["entries"]
    need(
        type(value["count"]) is int
        and 1 <= value["count"] <= 600
        and isinstance(entries, list)
        and len(entries) == value["count"],
        "invalid index count",
    )
    end = 0
    for row in entries:
        need(
            isinstance(row, dict) and set(row) == {"offset", "length", "sha256"},
            "invalid index entry",
        )
        need(
            type(row["offset"]) is int
            and type(row["length"]) is int
            and row["offset"] > end
            and row["length"] > 0
            and row["offset"] + row["length"] < size
            and hex_digest(row["sha256"]),
            "invalid index range",
        )
        end = row["offset"] + row["length"]


def select(request_path, request_sha, index_path, index_sha, index):
    need(hex_digest(request_sha) and hex_digest(index_sha), "invalid input digests")
    need(type(index) is int and 0 <= index < 600, "invalid original job index")
    with opened(index_path, INDEX_LIMIT) as (stream, size):
        raw_index = stream.read(size + 1)
        need(
            len(raw_index) == size and digest(raw_index) == index_sha,
            "index digest changed",
        )
        value = strict(raw_index)
        with opened(request_path, REQUEST_LIMIT) as (stream, size):
            check_index(value, request_sha, size)
            hasher = hashlib.sha256()
            total = 0
            while True:
                chunk = stream.read(CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                hasher.update(chunk)
            need(
                total == size and hasher.hexdigest() == request_sha,
                "request digest changed",
            )
            row = None
            if index < value["count"]:
                entry = value["entries"][index]
                stream.seek(entry["offset"])
                raw = stream.read(entry["length"])
                need(
                    len(raw) == entry["length"] and digest(raw) == entry["sha256"],
                    "selected row digest changed",
                )
                row = DECODER.decode(raw.decode("ascii"))
                need(
                    isinstance(row, dict) and encoded(row)[:-1] == raw,
                    "selected row is not canonical object",
                )
            # Context exit verifies both FD and path identities before caller receives data.
    return value["header"], row
