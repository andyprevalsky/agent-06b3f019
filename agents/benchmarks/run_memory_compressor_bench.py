#!/usr/bin/env python3
"""Memory compressor benchmark: real transcripts in, grounded critical paths out.

Runs the production compressor (same prompt, same LLM path) over the real
completed runs listed in ``memory_compressor_cases.json`` (one per benchmark
task plus the largest completed runs by context) and checks every output with
generic, transcript-grounded assertions — no per-case expectations, so the
prompt cannot be tuned to the suite:

  * valid, clamped record: 1..8 steps, <=5 detours, <=5 pitfalls, strings <=200 chars
  * outcome is "passed" (only completed runs become memories)
  * every step's tool is grounded: it names a tool that appears in the transcript
    (or one of the always-present meta tools)
  * every URL in the record appears verbatim in the transcript (no hallucinated URLs)
  * no emails, phone numbers, card numbers, or credential-shaped values
  * a non-empty terminal condition; entry points when the run used tools
  * big-context cases: the trimmed transcript hits the row/char bounds and the
    compressor still returns within the deadline

Usage:
    cd agents && python benchmarks/run_memory_compressor_bench.py [--only id,id] [--concurrency 4]
Outputs:
    agents/benchmarks/runs/memory-compressor-<ts>.json (inputs sizes, records, failures)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit

AGENTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENTS_ROOT))

CASES_PATH = AGENTS_ROOT / "benchmarks" / "memory_compressor_cases.json"
RUNS_DIR = AGENTS_ROOT / "benchmarks" / "runs"
MODEL = os.environ.get("PLANNER_MEMORY_COMPRESSOR_MODEL", "rose-labs/rose-1-ultra")
DEADLINE_S = 240.0
META_TOOLS = {"reasoning", "set_plan", "attempt_completion", "attempt_completion_with_result", "request_payment_card"}
_URL_RE = re.compile(r"https?://[^\s\"'<>)\]]+")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_E164_RE = re.compile(r"(?<![\w/.-])\+\d{10,15}(?![\w/-])")
_FORMATTED_PHONE_RE = re.compile(
    r"(?<![\w/.-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?![\w/-])"
)
_PAN_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_SECRET_RE = re.compile(
    r"(?i)(?:bearer\s+[A-Za-z0-9._~+/=-]{12,}|gh[pousr]_[A-Za-z0-9]{20,255}|"
    r"github_pat_[A-Za-z0-9_]{20,255}|sk-[A-Za-z0-9_-]{20,255}|"
    r"(?:api[_ -]?key|password|secret|token)\s*[:=]\s*[^\s,;]+)"
)
_SENSITIVE_QUERY_KEYS = {
    "card",
    "cardnumber",
    "card_number",
    "pan",
    "cvc",
    "cvv",
    "email",
    "e-mail",
    "phone",
    "mobile",
    "tel",
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "api-key",
    "authorization",
}


def _norm_tool(name: str) -> str:
    return re.sub(r"[^a-z_]", "", name.lower().replace("-", "_"))


def transcript_tools(transcript) -> set[str]:
    tools: set[str] = {_norm_tool(tool) for tool in transcript.tool_inventory}
    for row in transcript.rows:
        if row.tool:
            tools.add(_norm_tool(row.tool))
        for call in row.calls:
            if call.get("tool"):
                tools.add(_norm_tool(str(call["tool"])))
                if call.get("type"):
                    tools.add(_norm_tool(f"spawn_{call['type']}_agent"))
        if row.title:
            for meta in META_TOOLS:
                if meta in row.title.lower().replace(" ", "_"):
                    tools.add(meta)
    return tools


def _strip_url(url: str) -> str:
    return url.rstrip(".,;:)]}'\"…")


def _strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _strings(item)


def _urls(value: Any) -> set[str]:
    return {_strip_url(url) for text in _strings(value) for url in _URL_RE.findall(text)}


def _luhn_valid(value: str) -> bool:
    digits = [int(char) for char in value if char.isdigit()]
    if not 13 <= len(digits) <= 19:
        return False
    parity = len(digits) % 2
    total = 0
    for index, digit in enumerate(digits):
        if index % 2 == parity:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


def contains_sensitive_data(value: Any) -> bool:
    """Independent benchmark oracle; deliberately does not call production sanitization."""
    for text in _strings(value):
        decoded = unquote(text)
        if (
            _EMAIL_RE.search(decoded)
            or _E164_RE.search(decoded)
            or _FORMATTED_PHONE_RE.search(decoded)
            or _SECRET_RE.search(decoded)
        ):
            return True
        if any(_luhn_valid(match.group(0)) for match in _PAN_RE.finditer(decoded)):
            return True
        for url in _URL_RE.findall(text):
            for key, query_value in parse_qsl(urlsplit(url).query, keep_blank_values=True):
                if (
                    key.lower() in _SENSITIVE_QUERY_KEYS
                    and query_value
                    and not query_value.upper().startswith("REDACTED")
                ):
                    return True
    return False


def evaluate(transcript, record, elapsed_s: float) -> list[str]:
    """Generic grounded assertions; returns the list of failures (empty = pass)."""
    failures: list[str] = []
    payload = transcript.to_prompt_payload()
    payload_text = json.dumps(payload, ensure_ascii=False)
    tools = transcript_tools(transcript)
    if record.outcome != "passed":
        failures.append(f"outcome {record.outcome} (completed run)")
    steps = record.critical_path
    used_tools = bool(tools - META_TOOLS) or any(r.calls for r in transcript.rows)
    min_steps = 1 if used_tools else 0
    if not min_steps <= len(steps) <= 8:
        failures.append(f"{len(steps)} steps (expected {min_steps}..8)")
    if len(record.detours) > 5 or len(record.pitfalls) > 5:
        failures.append("detours/pitfalls over cap")
    if [s.step for s in steps] != list(range(1, len(steps) + 1)):
        failures.append("steps not 1..n")
    strings = [record.terminal_condition, *record.pitfalls, *[s.action for s in steps], *[s.result for s in steps]]
    strings += [d.tried for d in record.detours] + [d.why_it_failed for d in record.detours]
    if any(len(s) > 200 for s in strings):
        failures.append("string over 200 chars")
    if not record.terminal_condition.strip():
        failures.append("empty terminal_condition")
    payload_norm = _norm_tool(payload_text.replace(" ", "_"))
    recorded_tools = [entry.tool for entry in record.entry_points] + [step.tool for step in steps]
    for recorded_tool in recorded_tools:
        tool = _norm_tool(recorded_tool)
        if tool == "spawn_agent":
            failures.append("archive-internal spawn_agent tool leaked")
            break
        if tool in META_TOOLS or any(t and (t in tool or tool in t) for t in tools):
            continue
        # An action named in a chip/title (e.g. rotate_ip, evaluate) is grounded too.
        if (
            len(tool) >= 4
            and tool in payload_norm
            and tool not in {"assistant", "root_agent", "agent", "user", "system"}
        ):
            continue
        failures.append(f"ungrounded tool {recorded_tool!r} (transcript tools: {sorted(tools)[:6]})")
        break
    record_payload = record.model_dump()
    payload_urls = _urls(payload)
    payload_bare_urls = {re.sub(r"^https?://", "", candidate).rstrip("/").lower() for candidate in payload_urls}
    for url in _urls(record_payload):
        bare = re.sub(r"^https?://", "", url).rstrip("/").lower()
        if url in payload_urls or (bare and bare in payload_bare_urls):
            continue
        failures.append(f"URL not in transcript: {url[:80]}")
        break
    if contains_sensitive_data(record_payload):
        failures.append("sensitive data leaked")
    if tools - META_TOOLS and not record.entry_points:
        failures.append("no entry_points although the run used tools")
    for detour in record.detours:
        if detour.steps_wasted < 0 or not detour.tried.strip():
            failures.append("malformed detour")
            break
    if elapsed_s > DEADLINE_S:
        failures.append(f"took {elapsed_s:.0f}s > {DEADLINE_S:.0f}s")
    return failures


async def run_case(case: dict[str, Any], semaphore: asyncio.Semaphore) -> dict[str, Any]:
    from providers.planner_memory import compress_transcript, load_bundle_transcript
    from providers.planner_memory.transcript import MAX_ROWS, MAX_TRANSCRIPT_CHARS

    out: dict[str, Any] = {
        "id": case["id"],
        "task": case["task"],
        "kind": case["kind"],
        "llm_traces": case.get("llm_traces"),
    }
    async with semaphore:
        started = time.perf_counter()
        try:
            transcript = await asyncio.to_thread(load_bundle_transcript, case["id"])
            if transcript is None:
                out.update(passed=False, failures=["no transcript"])
                return out
            payload_chars = len(json.dumps(transcript.to_prompt_payload(), ensure_ascii=False))
            out["input"] = {
                "messages_total": transcript.total_rows,
                "rows_kept": len(transcript.rows),
                "dropped": transcript.dropped_rows,
                "payload_chars": payload_chars,
                "outcome": transcript.outcome,
            }
            if transcript.outcome != "passed":
                out.update(passed=False, failures=[f"selected run is not completed: {transcript.outcome_note}"])
                return out
            record = await asyncio.wait_for(compress_transcript(transcript, model=MODEL), timeout=DEADLINE_S + 30)
            elapsed = time.perf_counter() - started
            failures = evaluate(transcript, record, elapsed)
            if case["kind"] == "big" and not (
                len(transcript.rows) >= MAX_ROWS
                or payload_chars >= MAX_TRANSCRIPT_CHARS * 0.8
                or transcript.total_rows >= 60
            ):
                failures.append(
                    f"big case is not big: rows={transcript.total_rows} kept={len(transcript.rows)} chars={payload_chars}"
                )
            out.update(passed=not failures, failures=failures, elapsed_s=round(elapsed, 1), record=record.model_dump())
        except Exception as exc:
            out.update(
                passed=False,
                failures=[f"error: {type(exc).__name__}: {str(exc)[:200]}"],
                elapsed_s=round(time.perf_counter() - started, 1),
            )
    print(
        f"  {'✅' if out.get('passed') else '❌'} {case['task'][:36]:36} {case['id'][:8]} [{case['kind']}] "
        f"rows={out.get('input', {}).get('messages_total', '?')}→{out.get('input', {}).get('rows_kept', '?')} "
        f"{out.get('elapsed_s', '?')}s {('; '.join(out.get('failures', []))[:160])}",
        flush=True,
    )
    return out


async def store_records(results: list[dict[str, Any]], *, backend: str) -> int:
    """Pre-warm the history table's critical-path cache with the passing records (idempotent PATCH)."""
    import httpx

    from providers.planner_memory.compressor import COMPRESSOR_VERSION

    api_key = os.environ.get("BACKEND_API_KEY") or ""
    if not api_key:
        print("BACKEND_API_KEY required for --store-backend")
        return 0
    stored = 0
    async with httpx.AsyncClient(timeout=30) as client:
        for r in results:
            if not r.get("passed") or not r.get("record"):
                continue
            claim = await client.post(
                f"{backend.rstrip('/')}/api/planner-memory/{r['id']}/critical-path-claim",
                headers={"X-API-Key": api_key, "Content-Type": "application/json"},
                json={"compressor_version": COMPRESSOR_VERSION},
            )
            if claim.status_code != 200:
                continue
            claim_data = claim.json()
            if claim_data.get("reason") == "cached":
                stored += 1
                continue
            lease_id = claim_data.get("lease_id")
            if not claim_data.get("claimed") or not lease_id:
                continue
            resp = await client.patch(
                f"{backend.rstrip('/')}/api/planner-memory/{r['id']}/critical-path",
                headers={"X-API-Key": api_key, "Content-Type": "application/json"},
                json={
                    "critical_path": r["record"],
                    "compressor_version": COMPRESSOR_VERSION,
                    "lease_id": lease_id,
                },
            )
            stored += 1 if resp.status_code == 200 else 0
    print(f"🧠 stored {stored} critical paths into {backend}")
    return stored


async def main_async(args: argparse.Namespace) -> int:
    os.environ.setdefault("TRACE_ARCHIVE_BACKEND", "r2")
    os.environ.setdefault("TRACE_ARCHIVE_ENABLED", "0")  # never archive the compressor's own calls
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))["cases"]
    if args.only:
        wanted = set(args.only.split(","))
        cases = [c for c in cases if c["id"] in wanted or c["id"][:8] in wanted or c["task"] in wanted]
    if args.kind:
        cases = [c for c in cases if c["kind"] == args.kind]
    semaphore = asyncio.Semaphore(args.concurrency)
    results = list(await asyncio.gather(*(run_case(c, semaphore) for c in cases)))
    passed = sum(1 for r in results if r.get("passed"))
    big = [r for r in results if r["kind"] == "big"]
    summary = {
        "total": len(results),
        "passed": passed,
        "distinct_tasks": len({r["task"] for r in results}),
        "big_total": len(big),
        "big_passed": sum(1 for r in big if r.get("passed")),
        "max_input_messages": max((r.get("input", {}).get("messages_total", 0) for r in results), default=0),
        "max_payload_chars": max((r.get("input", {}).get("payload_chars", 0) for r in results), default=0),
        "median_elapsed_s": sorted(r.get("elapsed_s", 0) for r in results)[len(results) // 2] if results else 0,
        "failure_kinds": sorted({f.split(":")[0].split(" (")[0] for r in results for f in r.get("failures", [])}),
    }
    if args.store_backend:
        stored = await store_records(results, backend=args.store_backend)
        summary["stored_critical_paths"] = stored
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    out = RUNS_DIR / f"memory-compressor-{run_id}.json"
    out.write_text(
        json.dumps(
            {"run_id": run_id, "model": MODEL, "summary": summary, "cases": results}, indent=1, ensure_ascii=False
        ),
        encoding="utf-8",
    )
    print(json.dumps(summary, indent=1))
    print(f"📄 report: {out}")
    return 0 if passed == len(results) and results else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", default="")
    parser.add_argument("--kind", choices=["per_task", "big"], default=None)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--store-backend", default="", help="PATCH passing records into this backend's history table")
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
