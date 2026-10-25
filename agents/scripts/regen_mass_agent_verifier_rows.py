"""Regenerate mass-agent GP verifier rows recorded before the ProgressScoreWithOutput contract.

Usage (from agents/, venv active), against a finished mass-agent run record and its worker log:
    python scripts/regen_mass_agent_verifier_rows.py --run-json RUN.json --worker-log worker.log \
        --incomplete-only [--write]
Without --write it only reports which GPs would change. Needs agents/.env (BACKEND_API_KEY) and a
leasable Claude compute token for the benchmark user.

For each target GP: take the exact verifier request this replay built (llm.context.dumped),
run it live once through helpers.llm._call_llm_verifier with a leased compute token, keep the
streamed record exactly as RoseClient.complete produced it, validate the parsed output against
the GP's response_schema, and (with --write) upsert it at the same slot key through the supported
prod /api/fast-cache/set, with a backup and a provenance receipt.
"""

import argparse
import asyncio
import base64
import contextvars
import datetime
import gzip
import json
import os
import sys
import uuid
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import hashlib  # noqa: E402
import urllib.request  # noqa: E402

from dotenv import dotenv_values  # noqa: E402
from config import load_config  # noqa: E402
from helpers import llm  # noqa: E402
from providers.demo_cache.rose_cache import accumulate_chunk, empty_response  # noqa: E402
from providers.rose import RoseClient  # noqa: E402

BK = os.environ.get(
    "MA_REGEN_RECEIPT_DIR", os.path.join(os.path.dirname(__file__), "..", "..", ".context", "mass-agent-verifier-regen")
)
USER = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
API = os.environ.get("DEMO_CACHE_API", "https://navi-j9a9.onrender.com")


class dc:  # the supported prod DEMO-cache endpoints (/api/fast-cache/get|set)
    @staticmethod
    def call(path, body):
        key = dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))["BACKEND_API_KEY"]
        req = urllib.request.Request(
            f"{API}/api/fast-cache/{path}",
            data=json.dumps(body).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "X-API-Key": key},
        )
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.loads(response.read())

    @staticmethod
    def h(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


# One tee for every concurrent call: each task records into its own accumulator.
_CURRENT_ACC: contextvars.ContextVar = contextvars.ContextVar("regen_acc", default=None)
_ORIGINAL_COMPLETE = RoseClient.complete


_REPLAY: contextvars.ContextVar = contextvars.ContextVar("regen_replay", default=None)


async def _tee_complete(self, *args, **kwargs):
    replay = _REPLAY.get()
    if replay is not None:
        from providers.demo_cache.rose_cache import replay_with_context

        record, key = replay
        async for chunk in replay_with_context(
            record, call_site="verifier_execute", complete_kwargs=kwargs, cache_key=key, hit_key=key, reason="cache_hit"
        ):
            yield chunk
        return
    async for chunk in _ORIGINAL_COMPLETE(self, *args, **kwargs):
        acc = _CURRENT_ACC.get()
        if acc is not None:
            accumulate_chunk(acc, chunk)
        yield chunk


RoseClient.complete = _tee_complete


async def _replay_parse(record, schema, key):
    """Parse ``record`` exactly as a replay would; None when it does not parse."""
    token = _REPLAY.set((record, key))
    try:
        with patch("temporalio.activity.heartbeat"):
            result, _usage = await llm._call_llm_verifier(
                [{"role": "user", "content": "replay"}],
                "rose-labs/rose-1-ultra",
                load_config(),
                response_schema=schema,
                call_site="verifier_execute",
            )
        return result
    except Exception:
        return None
    finally:
        _REPLAY.reset(token)


def load_targets(run_json, worker_log, only):
    t = json.load(open(run_json))["tasks"][0]
    tree = t["logs"]["tree"]
    root = [k for k, n in tree.items() if not n.get("parent_agent_id")][0]
    gps = {
        k: n
        for k, n in tree.items()
        if n.get("parent_agent_id") == root and str(n.get("goal", "")).startswith("You are analyzing ONE creator")
    }
    dumps = {}
    with open(worker_log) as fh:
        for line in fh:
            if '"llm.context.dumped"' not in line or '"verifier_execute"' not in line:
                continue
            e = json.loads(line)
            if e.get("agent_id") in gps and e.get("payload_gzip_b64"):
                dumps[e["agent_id"]] = json.loads(gzip.decompress(base64.b64decode(e["payload_gzip_b64"])))
    out = []
    for aid, node in gps.items():
        if only and not any(aid.startswith(o) for o in only):
            continue
        out.append((aid, node, dumps.get(aid)))
    return out


def output_errors(schema, output):
    model = llm._build_verifier_response_model(schema).model_fields["output"].annotation
    try:
        model.model_validate(output or {})
        return []
    except Exception as error:
        return [f"{'.'.join(map(str, x['loc']))}:{x['type']}" for x in error.errors()]


async def regen_one(aid, node, dump, write):
    schema = node["response_schema"]
    hit_key = dump["extra"]["cache_hit_key"]
    if not str(hit_key).startswith("fastmode:"):
        # Cold namespace: no row was ever recorded for this GP's verifier slot. Create it
        # at the request's own slot key (p:N), which exact and positional lookup both find.
        hit_key = dump["extra"]["cache_key"]
        assert ":verifier_execute:p:" in hit_key, hit_key
    lineage = f"ma5-regen-{uuid.uuid4()}"
    with patch("temporalio.activity.heartbeat"):
        lease = await llm.fetch_compute_token_activity(USER, lineage_key=lineage, token_type="claude")
    acc = empty_response()
    token = _CURRENT_ACC.set(acc)
    try:
        with patch("temporalio.activity.heartbeat"):
            result, usage = await llm._call_llm_verifier(
                dump["messages"],
                "rose-labs/rose-1-ultra",
                load_config(),
                response_schema=schema,
                claude_token=(lease or {}).get("accessToken"),
                claude_token_source=(lease or {}).get("source"),
                claude_token_pool_id=(lease or {}).get("poolTokenId"),
                claude_token_user_id=USER,
                compute_token_lineage_key=lineage,
                call_site="verifier_execute",
                agent_id=aid,
            )
    finally:
        _CURRENT_ACC.reset(token)
        with patch("temporalio.activity.heartbeat"):
            await llm.release_compute_token_lineage_activity(lineage)
    # Validate what will be STORED: replay the record through the same parse path.
    replayed = await _replay_parse(acc, schema, hit_key)
    if replayed is None:
        return {"agent_id": aid, "error": "stored record does not replay-parse", "hit_key": hit_key}
    result = replayed
    errors = output_errors(schema, result.get("output"))
    rec = {
        "agent_id": aid,
        "creator": (node.get("structured_output") or {}).get("creator_name"),
        "hit_key": hit_key,
        "score": result.get("score"),
        "output_errors": errors,
        "actual_model": usage.get("actual_model"),
        "pool": usage.get("pool_name"),
        "record_actual_model": acc.get("actual_model"),
    }
    if write and not errors:
        cur = dc.call("get", {"key": hit_key})
        if not cur.get("hit"):
            cur = {"hit": False, "value": None, "blobPath": None}
        os.umask(0o077)
        os.makedirs(BK, exist_ok=True)
        stamp = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
        path = os.path.join(BK, f"{stamp}_{hit_key.replace(':', '_')}.json")
        json.dump(
            {"key": hit_key, "value": cur["value"], "blobPath": cur.get("blobPath"), "sha256": dc.h(cur["value"])},
            open(path, "w"),
        )
        goal_hash = hit_key.split(":")[3]
        r = dc.call(
            "set", {"key": hit_key, "kind": "llm", "goalHash": goal_hash, "value": acc, "blobPath": cur.get("blobPath")}
        )
        assert r.get("stored") is True, r
        back = dc.call("get", {"key": hit_key})
        assert dc.h(back["value"]) == dc.h(acc), "read-back mismatch"
        rec.update(
            {
                "before_sha256": dc.h(cur["value"]) if cur.get("hit") else None,
                "after_sha256": dc.h(acc),
                "backup": path,
                "at": stamp,
                "provenance": "live replay of the recorded verifier_execute request (llm.context.dumped) via "
                "helpers.llm._call_llm_verifier, leased claude compute token",
            }
        )
        with open(os.path.join(BK, "receipt.jsonl"), "a") as fh:
            fh.write(json.dumps(rec) + "\n")
    return rec


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-json", required=True)
    ap.add_argument("--worker-log", required=True)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--incomplete-only", action="store_true")
    ap.add_argument("--concurrency", type=int, default=4)
    a = ap.parse_args()
    targets = load_targets(a.run_json, a.worker_log, a.only)
    if a.incomplete_only:
        targets = [x for x in targets if output_errors(x[1]["response_schema"], x[1].get("structured_output"))]
    print(f"targets: {len(targets)}", flush=True)
    sem = asyncio.Semaphore(a.concurrency)

    async def run(x):
        async with sem:
            if x[2] is None:
                return {"agent_id": x[0], "skipped": "no verifier dump"}
            try:
                return await regen_one(*x, a.write)
            except Exception as error:
                return {"agent_id": x[0], "error": f"{type(error).__name__}: {str(error)[:300]}"}

    for rec in await asyncio.gather(*(run(x) for x in targets)):
        print(json.dumps(rec), flush=True)


asyncio.run(main())
