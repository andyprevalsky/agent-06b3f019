#!/usr/bin/env python3
"""Refuse benchmark concurrency above the measured provider rate-limit cap.

Benchmark guests share provider keys with production. For every *enforced*
provider in the reviewed registry (exhaustion is task-visible and has no
unlimited fallback) the cap is

    floor(limit * (1 - production_reserve_fraction) / per_bench_peak)

and the overall cap is the minimum across enforced providers. Informational
providers (exhaustion falls back and recovers) never refuse a run; they are
printed as notes once the requested width exceeds their own cap.

Usage:
    cloudbench-provider-capacity.py check --benches N   # exit 0, or 78 + refusal
    cloudbench-provider-capacity.py cap [--json]        # print the cap

There is no bypass: raising the cap means recording new provider limits in
scripts/cloudbench-provider-limits.json in a reviewed change.
CLOUDBENCH_PROVIDER_LIMITS_FILE may select another registry, which is
validated identically to the canonical one and announced on stderr.
Standard library only; no provider or network calls.
"""
from __future__ import annotations

import argparse
from decimal import Decimal
from fractions import Fraction
import json
import math
import os
from pathlib import Path
import re
import sys

SCHEMA = "cloudbench-provider-limits-v1"
CANONICAL_REGISTRY = Path(__file__).resolve().with_name("cloudbench-provider-limits.json")
CANONICAL_LABEL = "scripts/cloudbench-provider-limits.json"
REGISTRY_ENV = "CLOUDBENCH_PROVIDER_LIMITS_FILE"
EXIT_REFUSED = 78  # EX_CONFIG: provider configuration cannot serve this width.
EXIT_INVALID = 2
MAX_REGISTRY_BYTES = 256 * 1024

_TOP_KEYS = {"schema", "production_reserve_fraction", "production_reserve_note",
             "measurement", "enforced", "informational"}
_MEASUREMENT_KEYS = {"id", "date", "concurrent_benches", "source"}
_PROVIDER_KEYS = {"id", "name", "limit", "limit_unit", "limit_qualifier", "credential_env",
                  "per_bench_peak", "per_bench_peak_unit", "limit_source", "demand_source"}
_ENFORCED_KEYS = _PROVIDER_KEYS | {"exhaustion"}
_INFORMATIONAL_KEYS = _PROVIDER_KEYS | {"fallback"}


class RegistryError(ValueError):
    """The provider-limit registry is missing or malformed (fail closed)."""


def _text(value: object, field: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value.strip() or value != value.strip() or "\n" in value:
        raise RegistryError(f"provider limit registry: {field} must be a nonempty one-line string")
    return value


def _positive(value: object, field: str) -> Fraction:
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise RegistryError(f"provider limit registry: {field} must be a number")
    if isinstance(value, Decimal) and not value.is_finite():
        raise RegistryError(f"provider limit registry: {field} must be finite")
    exact = Fraction(value)
    if exact <= 0:
        raise RegistryError(f"provider limit registry: {field} must be positive")
    return exact


def _number_text(value: int | Decimal) -> str:
    """600 -> '600', 13330000 -> '13,330,000', 6.83 -> '6.83' (exact registry digits)."""
    if isinstance(value, int) or value == value.to_integral_value():
        return f"{int(value):,}"
    return format(value.normalize(), "f")


def _provider(row: object, field: str, keys: set[str], reserve: Fraction) -> dict:
    if not isinstance(row, dict) or set(row) != keys:
        raise RegistryError(f"provider limit registry: {field} must have exactly {sorted(keys)}")
    provider_id = _text(row["id"], field + ".id")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,63}", provider_id):
        raise RegistryError(f"provider limit registry: {field}.id must be a lowercase slug")
    for key in ("name", "limit_unit", "per_bench_peak_unit", "limit_source", "demand_source"):
        _text(row[key], f"{field}.{key}")
    _text(row["limit_qualifier"], field + ".limit_qualifier", nullable=True)
    credential = _text(row["credential_env"], field + ".credential_env")
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*\*?", credential):
        raise RegistryError(f"provider limit registry: {field}.credential_env must name an env key")
    limit = _positive(row["limit"], field + ".limit")
    peak = _positive(row["per_bench_peak"], field + ".per_bench_peak")
    usable = limit * (1 - reserve)
    return dict(row, cap=math.floor(usable / peak))


def load_registry(path: Path | None = None) -> dict:
    """Read and validate one registry; the canonical file unless explicitly selected."""
    selected = path
    if selected is None:
        override = os.environ.get(REGISTRY_ENV)
        if override is not None:
            if not override or not Path(override).is_absolute():
                raise RegistryError(f"{REGISTRY_ENV} must be an absolute registry path")
            selected = Path(override)
    selected = selected or CANONICAL_REGISTRY
    try:
        if selected.is_symlink() or not selected.is_file():
            raise RegistryError(f"provider limit registry is not a regular file: {selected}")
        raw = selected.read_bytes()
    except OSError as error:
        raise RegistryError(f"provider limit registry unreadable: {selected}: {error.strerror}") from None
    if len(raw) > MAX_REGISTRY_BYTES:
        raise RegistryError("provider limit registry exceeds its size bound")
    try:
        value = json.loads(raw.decode("utf-8"), parse_float=Decimal, parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError) as error:
        raise RegistryError(f"provider limit registry is not valid JSON: {error}") from None
    if not isinstance(value, dict) or set(value) != _TOP_KEYS or value["schema"] != SCHEMA:
        raise RegistryError(f"provider limit registry must be one {SCHEMA} object")
    _text(value["production_reserve_note"], "production_reserve_note")
    reserve_raw = value["production_reserve_fraction"]
    if isinstance(reserve_raw, bool) or not isinstance(reserve_raw, (int, Decimal)):
        raise RegistryError("provider limit registry: production_reserve_fraction must be a number")
    reserve = Fraction(reserve_raw)
    if not 0 <= reserve < 1:
        raise RegistryError("provider limit registry: production_reserve_fraction must be in [0, 1)")
    measurement = value["measurement"]
    if not isinstance(measurement, dict) or set(measurement) != _MEASUREMENT_KEYS:
        raise RegistryError(f"provider limit registry: measurement must have exactly {sorted(_MEASUREMENT_KEYS)}")
    _text(measurement["id"], "measurement.id")
    _text(measurement["source"], "measurement.source")
    if not isinstance(measurement["date"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", measurement["date"]):
        raise RegistryError("provider limit registry: measurement.date must be YYYY-MM-DD")
    if isinstance(measurement["concurrent_benches"], bool) or not isinstance(measurement["concurrent_benches"], int) \
            or measurement["concurrent_benches"] < 1:
        raise RegistryError("provider limit registry: measurement.concurrent_benches must be a positive integer")
    enforced, informational = value["enforced"], value["informational"]
    if not isinstance(enforced, list) or not enforced or not isinstance(informational, list):
        raise RegistryError("provider limit registry: enforced must be a nonempty list and informational a list")
    rows = [_provider(row, f"enforced[{i}]", _ENFORCED_KEYS, reserve) for i, row in enumerate(enforced)]
    notes = [_provider(row, f"informational[{i}]", _INFORMATIONAL_KEYS, reserve) for i, row in enumerate(informational)]
    for i, row in enumerate(rows):
        _text(row["exhaustion"], f"enforced[{i}].exhaustion")
    for i, row in enumerate(notes):
        _text(row["fallback"], f"informational[{i}].fallback")
    ids = [row["id"] for row in rows + notes]
    if len(set(ids)) != len(ids):
        raise RegistryError("provider limit registry: provider ids must be unique")
    return dict(path=selected, canonical=selected.resolve() == CANONICAL_REGISTRY, reserve=reserve,
                measurement=measurement, enforced=rows, informational=notes,
                cap=min(row["cap"] for row in rows))


def _reject_constant(name: str) -> None:
    raise ValueError(f"non-finite constant {name}")


def _limit_text(row: dict) -> str:
    text = f"{_number_text(row['limit'])} {row['limit_unit']}"
    return text + (f", {row['limit_qualifier']}" if row["limit_qualifier"] else "")


def _provider_line(row: dict, measurement_id: str) -> str:
    return (f"{row['name']}: {_limit_text(row)} ({row['credential_env']}) → max {row['cap']} concurrent benches "
            f"(peak {_number_text(row['per_bench_peak'])} {row['per_bench_peak_unit']}, measured {measurement_id})")


def _percent(reserve: Fraction) -> str:
    value = reserve * 100
    return f"{value.numerator}%" if value.denominator == 1 else f"{float(value):g}%"


def refusal_message(registry: dict, benches: int) -> str | None:
    """The exact operator-facing refusal, or None when the width fits."""
    if benches <= registry["cap"]:
        return None
    limiting = sorted((row for row in registry["enforced"] if row["cap"] < benches),
                      key=lambda row: (row["cap"], row["id"]))
    measured = registry["measurement"]["id"]
    cap = registry["cap"]
    return "\n".join([
        f"❌ Benchmark concurrency is limited by provider rate limits: requested {benches} concurrent benches, maximum {cap}.",
        f"Limiting providers ({_percent(registry['reserve'])} of each limit reserved for production):",
        *(f"  - {_provider_line(row, measured)}" for row in limiting),
        "STOP: do not retry, split, or work around this limit. Halt and ask the user to either",
        f"  1. increase these provider rate limits (then record the new limits in {CANONICAL_LABEL}), or",
        f"  2. rerun with a lower concurrency ({cap} or fewer concurrent benches).",
    ])


def informational_notes(registry: dict, benches: int) -> list[str]:
    measured = registry["measurement"]["id"]
    return [f"ℹ️  provider note (not enforced): {_provider_line(row, measured)}; {row['fallback']}"
            for row in sorted(registry["informational"], key=lambda row: (row["cap"], row["id"]))
            if row["cap"] < benches]


def check(benches: int, *, stream=None, registry: dict | None = None) -> int:
    """Return 0 when `benches` simultaneous benches fit, else EXIT_REFUSED after printing why."""
    stream = stream or sys.stderr
    if isinstance(benches, bool) or not isinstance(benches, int) or benches < 0:
        raise ValueError("simultaneous bench count must be a nonnegative integer")
    registry = registry or load_registry()
    if not registry["canonical"]:
        print(f"⚠️  provider limits from {REGISTRY_ENV}={registry['path']} (validated; not the reviewed "
              f"{CANONICAL_LABEL})", file=stream, flush=True)
    message = refusal_message(registry, benches)
    if message is not None:
        print(message, file=stream, flush=True)
        return EXIT_REFUSED
    for note in informational_notes(registry, benches):
        print(note, file=stream, flush=True)
    return 0


def _table(registry: dict) -> dict:
    def row(item: dict) -> dict:
        return dict(id=item["id"], name=item["name"], limit=_limit_text(item), credential_env=item["credential_env"],
                    per_bench_peak=f"{_number_text(item['per_bench_peak'])} {item['per_bench_peak_unit']}",
                    max_concurrent_benches=item["cap"])
    return dict(max_concurrent_benches=registry["cap"], production_reserve=_percent(registry["reserve"]),
                measurement=registry["measurement"]["id"], registry=str(registry["path"]),
                enforced=[row(item) for item in registry["enforced"]],
                informational=[dict(row(item), fallback=item["fallback"]) for item in registry["informational"]])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    checking = commands.add_parser("check", help="refuse a simultaneous width above the provider cap")
    checking.add_argument("--benches", required=True, type=int, help="global simultaneous bench count")
    capping = commands.add_parser("cap", help="print the provider concurrency cap")
    capping.add_argument("--json", action="store_true", help="print every provider's cap as JSON")
    args = parser.parse_args(argv)
    try:
        if args.command == "check":
            if args.benches < 0:
                parser.error("--benches must be a nonnegative integer")
            return check(args.benches)
        registry = load_registry()
        print(json.dumps(_table(registry), indent=2) if args.json else registry["cap"])
        return 0
    except RegistryError as error:
        print(f"❌ {error}; benchmark concurrency cannot be admitted without a valid provider limit registry",
              file=sys.stderr)
        return EXIT_INVALID


if __name__ == "__main__":
    raise SystemExit(main())
