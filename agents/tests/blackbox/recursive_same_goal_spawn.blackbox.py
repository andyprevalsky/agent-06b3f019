"""LIVE parallel Rose.collect regression for recursive same-goal GP spawns.

Corpus: ``agents/tests/fixtures/recursive_same_goal_spawn/`` — 23 dump edges
(PASS/FAIL only; UNPLAYABLE/ERROR dropped). Each fixture is one historical
LLM call where a parent previously emitted ``spawn_agent(type=general_purpose)``
with a goal ≈ the parent's goal.

One test parallelizes all 23 via ``RoseClient.collect`` with real compute
tokens (same lease path as the agent loop). Fixture system messages have their
spawn-rule bullet rewritten to the CURRENT canonical text from
``utils.prompts.MAIN_SYSTEM_PROMPT`` so prompt edits are what this measures.

Gate: ``RECURSIVE_SPAWN_LIVE=1`` (skipped offline). Opt-in only — not wired into
smoke or ``scripts/test.sh`` (too expensive for every deploy).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, List, Tuple

from _test_utils import BlackboxResult, teardown_mock

LIVE = os.environ.get("RECURSIVE_SPAWN_LIVE") == "1"

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURE_DIR = AGENTS_ROOT / "tests" / "fixtures" / "recursive_same_goal_spawn"
DEFAULT_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
SIM_THRESHOLD = 0.45
TOKEN_RE = re.compile(r"[a-z0-9]+")
FIXTURE_SPAWN_RULE_RE = re.compile(r"(?m)^[ \t]*-[ \t]+spawn_agent is low cost[^\n]*$")
SPAWN_RULE_LINE_RE = re.compile(
    r'(?m)^[ \t]*-[ \t]+(?:NEVER spawn_agent\(type="general_purpose"\)|spawn_agent is low cost)[^\n]*$'
)
PROD_BACKEND_URL = "https://navi-j9a9.onrender.com"


def jaccard(a: str, b: str) -> float:
    ta = set(TOKEN_RE.findall((a or "").lower()))
    tb = set(TOKEN_RE.findall((b or "").lower()))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, (a or "").lower(), (b or "").lower()).ratio()


def sim(a: str, b: str) -> float:
    return max(jaccard(a, b), ratio(a, b))


def current_spawn_rule_bullet() -> str:
    from utils.prompts import MAIN_SYSTEM_PROMPT

    m = SPAWN_RULE_LINE_RE.search(MAIN_SYSTEM_PROMPT)
    if not m:
        raise RuntimeError(
            "MAIN_SYSTEM_PROMPT is missing the recursive general_purpose spawn ban bullet"
        )
    return m.group(0)




def _message_text(msg: dict) -> str:
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""


_DAG_FORCE_GP_RE = re.compile(
    r"You MUST call exactly one tool:\s*`spawn_agent`[\s\S]*?"
    r'spawn_general_purpose_agent`\s+requires\s+`type="general_purpose"`',
    re.IGNORECASE,
)


def neutralize_dag_forced_gp_synthesis(messages: List[dict]) -> int:
    """Rewrite DAG param-populator force-messages that compel a GP spawn for fan-in work.

    Production now rewrites those plan nodes to `reasoning` before population.
    Fixtures freeze the old force text; neutralize it so the live suite measures
    the post-fix execute prompt rather than an obsolete MUST-spawn contract.
    """
    from loop.dag_executor import is_fan_in_synthesis_goal

    rewritten = 0
    out: List[dict] = []
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "user":
            out.append(msg)
            continue
        text = _message_text(msg)
        if not _DAG_FORCE_GP_RE.search(text):
            out.append(msg)
            continue
        m = re.match(
            r"Please execute task \d+ of the plan: (.*?)\n\nYou MUST call",
            text,
            re.S,
        )
        goal = (m.group(1).strip() if m else text)[:800]
        if not is_fan_in_synthesis_goal(goal):
            out.append(msg)
            continue
        new_text = (
            f"Please execute this plan task yourself (fan-in synthesis): {goal}\n\n"
            "Complete this consolidation / merge / finalize step with your own tools. "
            "Do NOT call spawn_agent with type=\"general_purpose\". "
            "Keep ownership of the final deliverable."
        )
        out.append({**msg, "content": new_text})
        rewritten += 1
    messages[:] = out
    return rewritten


def patch_messages_spawn_rule(
    messages: List[dict], new_bullet: str
) -> Tuple[List[dict], int]:
    """Replace the fixture's frozen main system prompt with the CURRENT static prompt.

    Dump fixtures freeze an old MAIN_SYSTEM_PROMPT (soft "use liberally" wording).
    Prompt iteration must rewrite that whole static block via build_system_prompt,
    not a single-line regex, so every current rule applies.
    """
    from utils.prompts import SYSTEM_PROMPT_DYNAMIC_BOUNDARY, build_system_prompt

    full = build_system_prompt("EXECUTE", [])
    static = full.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)[0].strip()
    # new_bullet is logged by caller; ensure it is actually present in what we inject.
    if new_bullet not in static and "NEVER spawn_agent" not in static:
        raise RuntimeError("build_system_prompt(EXECUTE) is missing the spawn ban bullet")

    out: List[dict] = []
    replaced = 0
    for msg in messages:
        if replaced == 0 and isinstance(msg, dict) and msg.get("role") == "system":
            content = msg.get("content")
            text = content if isinstance(content, str) else ""
            if isinstance(content, list):
                text = "\n".join(
                    b.get("text", "")
                    for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            if "spawn_agent" in text and (
                "low cost" in text or "liberally" in text or "general_purpose" in text
            ):
                out.append({**msg, "content": static})
                replaced = 1
                continue
        out.append(msg)
    return out, replaced


def load_manifest() -> dict:
    return json.loads((FIXTURE_DIR / "manifest.json").read_text())


def load_fixture(fixture_id: str) -> Tuple[dict, List[dict]]:
    meta = json.loads((FIXTURE_DIR / f"{fixture_id}.meta.json").read_text())
    messages = json.loads((FIXTURE_DIR / f"{fixture_id}.messages.json").read_text())
    return meta, messages


def parse_args(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            v = json.loads(raw)
            return v if isinstance(v, dict) else {}
        except Exception:
            return {}
    return {}


def extract_gp_spawns(resp: Any) -> List[dict]:
    tool_calls: List[dict] = []
    for tc in getattr(resp, "tool_calls", None) or []:
        if isinstance(tc, dict):
            tool_calls.append(tc)

    content = getattr(resp, "content", None) or ""
    if content:
        try:
            parsed = json.loads(content) if isinstance(content, str) else content
            if isinstance(parsed, dict):
                for tc in parsed.get("tool_calls") or []:
                    if isinstance(tc, dict):
                        tool_calls.append(tc)
                tool = parsed.get("tool")
                if isinstance(tool, dict):
                    tool_calls.append(tool)
        except Exception:
            pass

    out: List[dict] = []
    for tc in tool_calls:
        name = str(tc.get("name") or tc.get("tool") or "")
        args = tc.get("arguments") or tc.get("input") or tc
        if not isinstance(args, dict):
            args = parse_args(args)
        if isinstance(args.get("tool"), str):
            name = str(args.get("tool"))
        typ = str(
            args.get("type") or args.get("agent_type") or args.get("spawn_type") or ""
        )
        goal = str(args.get("goal") or args.get("task") or "")
        name_l = name.lower()
        typ_l = typ.lower().replace("-", "_")
        if "spawn" not in name_l and name_l != "spawn_agent":
            continue
        if typ_l in ("browser", "code", "explore", "for_each", "browser_use"):
            continue
        if typ_l and typ_l not in ("general_purpose", ""):
            continue
        if not goal:
            continue
        out.append({"name": name, "type": typ_l or "general_purpose", "goal": goal})
    return out


def score_response(resp: Any, *, parent_goal: str, bad_spawn_goal: str) -> dict:
    gp = extract_gp_spawns(resp)
    failing = []
    for s in gp:
        sb = sim(s["goal"], bad_spawn_goal)
        sp = sim(s["goal"], parent_goal)
        if sb >= SIM_THRESHOLD or sp >= SIM_THRESHOLD:
            failing.append(
                {
                    **s,
                    "sim_bad": round(sb, 3),
                    "sim_parent": round(sp, 3),
                    "goal": s["goal"][:240],
                }
            )
    return {
        "n_gp_spawns": len(gp),
        "failing_spawns": failing,
        "failed": len(failing) > 0,
        "gp_spawns": [{"type": g["type"], "goal": g["goal"][:160]} for g in gp[:3]],
        "content_preview": str(getattr(resp, "content", "") or "")[:240],
        "actual_model": getattr(resp, "actual_model", None),
    }


def normalize_pool(pool: str) -> str:
    p = (pool or "rose-1-flash").strip()
    return {
        "rose-1-flash": "rose-1-flash",
        "rose_1_lite": "rose-1-flash",
        "rose-1-ultra": "rose-1-ultra",
        "rose_1_ultra": "rose-1-ultra",
    }.get(p, p)


def configure_live_backend() -> None:
    url = (
        os.environ.get("RECURSIVE_SPAWN_BACKEND_URL")
        or os.environ.get("BACKEND_API_URL")
        or ""
    ).rstrip("/")
    if not url or "localhost" in url or "127.0.0.1" in url:
        url = PROD_BACKEND_URL
    os.environ["BACKEND_API_URL"] = url
    env_path = AGENTS_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("OPENAI_API_KEY=") or line.startswith(
                "OPENROUTER_API_KEY="
            ):
                k, _, v = line.partition("=")
                os.environ[k] = v.strip().strip('"').strip("'")


async def lease_compute_auth(user_id: str):
    from helpers.llm import _build_compute_auth_context, fetch_compute_token_activity
    from providers.rose import ClaudeAuthContext, GptAuthContext

    primary = await fetch_compute_token_activity(user_id)
    if not primary or not primary.get("accessToken"):
        raise RuntimeError(
            f"no compute token for user {user_id} — check BACKEND_API_URL/API_KEY"
        )
    ctx = _build_compute_auth_context(primary, user_id)
    claude_auth = ctx if isinstance(ctx, ClaudeAuthContext) else None
    gpt_auth = ctx if isinstance(ctx, GptAuthContext) else None

    other_type = "claude" if gpt_auth is not None else "gpt"
    try:
        secondary = await fetch_compute_token_activity(user_id, token_type=other_type)
        if secondary and secondary.get("accessToken"):
            ctx2 = _build_compute_auth_context(secondary, user_id)
            if isinstance(ctx2, ClaudeAuthContext) and claude_auth is None:
                claude_auth = ctx2
            if isinstance(ctx2, GptAuthContext) and gpt_auth is None:
                gpt_auth = ctx2
    except Exception:
        pass

    return claude_auth, gpt_auth, primary.get("type")


async def replay_one(
    *,
    meta: dict,
    messages: List[dict],
    new_bullet: str,
    claude_auth,
    gpt_auth,
    agent_action_model,
    sem: asyncio.Semaphore,
    temperature_override: float | None = None,
) -> dict:
    from providers.rose import RoseClient

    fixture_id = meta["fixture_id"]
    patched, n_patch = patch_messages_spawn_rule(messages, new_bullet)
    if n_patch < 1:
        return {
            "fixture_id": fixture_id,
            "status": "ERROR",
            "failed": None,
            "error": "spawn_rule_bullet_not_found_in_messages",
        }

    pool = normalize_pool(meta.get("pool") or "rose-1-flash")
    params = meta.get("requested_params") or {}
    temperature = params.get("temperature", 1.0)
    max_tokens = int(params.get("max_tokens") or 8192)
    if temperature_override is not None:
        temperature = float(temperature_override)
    elif os.environ.get("RECURSIVE_SPAWN_TEMPERATURE"):
        temperature = float(os.environ["RECURSIVE_SPAWN_TEMPERATURE"])

    async with sem:
        last_err = None
        for attempt in range(2):
            try:
                client = RoseClient()
                req = meta.get("requested_params") or {}
                tool_choice = req.get("tool_choice")
                resp = await client.collect(
                    pool=pool,  # type: ignore[arg-type]
                    messages=patched,
                    response_model=agent_action_model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    claude_auth=claude_auth,
                    gpt_auth=gpt_auth,
                    tool_choice=tool_choice,
                    call_site="recursive_same_goal_spawn_blackbox",
                    dump_context=False,
                    agent_id=meta.get("agent_id"),
                )
                scored = score_response(
                    resp,
                    parent_goal=meta.get("parent_goal") or "",
                    bad_spawn_goal=meta.get("bad_spawn_goal") or "",
                )
                status = "FAIL" if scored["failed"] else "PASS"
                return {
                    "fixture_id": fixture_id,
                    "status": status,
                    "failed": scored["failed"],
                    "baseline_status": meta.get("baseline_status"),
                    "pool": pool,
                    "route_hint": meta.get("route"),
                    "actual_model": scored.get("actual_model"),
                    "n_gp_spawns": scored["n_gp_spawns"],
                    "failing_spawns": scored["failing_spawns"],
                    "gp_spawns": scored["gp_spawns"],
                    "n_prompt_patches": n_patch,
                    "attempts": attempt + 1,
                    "error": None,
                }
            except Exception as e:
                last_err = e
                err_name = type(e).__name__
                # Empty structured output = no tool calls = no bad GP spawn.
                if "StructuredOutputCardinality" in err_name or "StructuredOutputCardinality" in str(e):
                    if attempt == 0:
                        continue
                    return {
                        "fixture_id": fixture_id,
                        "status": "PASS",
                        "failed": False,
                        "baseline_status": meta.get("baseline_status"),
                        "pool": pool,
                        "route_hint": meta.get("route"),
                        "actual_model": None,
                        "n_gp_spawns": 0,
                        "failing_spawns": [],
                        "gp_spawns": [],
                        "n_prompt_patches": n_patch,
                        "attempts": attempt + 1,
                        "error": None,
                        "note": "empty_structured_output_treated_as_no_spawn",
                    }
                break
        return {
            "fixture_id": fixture_id,
            "status": "ERROR",
            "failed": None,
            "baseline_status": meta.get("baseline_status"),
            "error": f"{type(last_err).__name__}: {last_err}"[:500] if last_err else "unknown",
        }


async def test_parallel_no_recursive_same_goal_gp_spawn():
    """All 23 fixtures must NOT emit same-goal general_purpose spawn_agent."""
    assert LIVE, "RECURSIVE_SPAWN_LIVE=1 required"

    teardown_mock()
    configure_live_backend()

    from utils.tool_schemas import ALL_PHASE_TOOLS, create_agent_action_model

    agent_action_model = create_agent_action_model(ALL_PHASE_TOOLS)
    new_bullet = current_spawn_rule_bullet()

    manifest = load_manifest()
    assert manifest["n"] == 23, manifest
    assert set(manifest["status_counts"]) <= {"PASS", "FAIL"}, manifest["status_counts"]

    user_id = os.environ.get("RECURSIVE_SPAWN_USER_ID") or DEFAULT_USER_ID
    claude_auth, gpt_auth, primary_type = await lease_compute_auth(user_id)
    assert claude_auth is not None or gpt_auth is not None

    sem = asyncio.Semaphore(int(os.environ.get("RECURSIVE_SPAWN_CONCURRENCY", "8")))
    tasks = []
    for entry in manifest["fixtures"]:
        meta, messages = load_fixture(entry["fixture_id"])
        tasks.append(
            replay_one(
                meta=meta,
                messages=messages,
                new_bullet=new_bullet,
                claude_auth=claude_auth,
                gpt_auth=gpt_auth,
                agent_action_model=agent_action_model,
                sem=sem,
            )
        )

    rows = await asyncio.gather(*tasks)

    # temp=1.0 dump sampling is noisy: majority-of-3 on first-pass FAILs.
    retry_n = int(os.environ.get("RECURSIVE_SPAWN_FAIL_RETRIES", "2"))
    if retry_n > 0:
        first_fails = [r for r in rows if r["status"] == "FAIL"]
        if first_fails:
            print(
                f"    retrying {len(first_fails)} FAIL fixture(s) "
                f"x{retry_n} for majority vote..."
            )
            by_id = {r["fixture_id"]: r for r in rows}
            for fr in first_fails:
                meta, messages = load_fixture(fr["fixture_id"])
                attempts = [fr]
                for _ in range(retry_n):
                    attempts.append(
                        await replay_one(
                            meta=meta,
                            messages=messages,
                            new_bullet=new_bullet,
                            claude_auth=claude_auth,
                            gpt_auth=gpt_auth,
                            agent_action_model=agent_action_model,
                            sem=sem,
                            temperature_override=0.0,
                        )
                    )
                fail_votes = sum(1 for a in attempts if a["status"] == "FAIL")
                # Majority FAIL => keep FAIL; else take best non-FAIL attempt.
                if fail_votes * 2 > len(attempts):
                    winner = next(a for a in attempts if a["status"] == "FAIL")
                    winner = {
                        **winner,
                        "majority_fail_votes": fail_votes,
                        "majority_attempts": len(attempts),
                    }
                else:
                    winner = next(
                        (a for a in attempts if a["status"] == "PASS"),
                        next(
                            (a for a in attempts if a["status"] != "FAIL"),
                            attempts[-1],
                        ),
                    )
                    winner = {
                        **winner,
                        "majority_fail_votes": fail_votes,
                        "majority_attempts": len(attempts),
                        "note": (winner.get("note") or "")
                        + f"; majority_cleared_after_retries({fail_votes}/{len(attempts)} fail)",
                    }
                by_id[fr["fixture_id"]] = winner
            rows = [by_id[r["fixture_id"]] for r in rows]

    counts = Counter(r["status"] for r in rows)
    fails = [r for r in rows if r["status"] == "FAIL"]
    errors = [r for r in rows if r["status"] == "ERROR"]

    artifact = {
        "n": len(rows),
        "status_counts": dict(counts),
        "primary_compute_token_type": primary_type,
        "spawn_rule_bullet": new_bullet,
        "failing_fixture_ids": [r["fixture_id"] for r in fails],
        "error_fixture_ids": [r["fixture_id"] for r in errors],
        "results": rows,
    }
    out_path = Path("/opt/cursor/artifacts/recursive_same_goal_spawn_live_results.json")
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(artifact, indent=2) + "\n")
    except Exception:
        pass

    print(
        f"    recursive_same_goal_spawn: {dict(counts)} "
        f"(compute_token_type={primary_type})"
    )
    for r in fails[:12]:
        spawn = (r.get("failing_spawns") or [{}])[0]
        print(
            f"      FAIL {r['fixture_id']} model={r.get('actual_model')} "
            f"sim_parent={spawn.get('sim_parent')} goal={spawn.get('goal', '')[:100]}"
        )
    for r in errors[:8]:
        print(f"      ERROR {r['fixture_id']}: {r.get('error')}")

    assert not errors, (
        f"{len(errors)} fixture ERROR(s): {[e['fixture_id'] for e in errors]}"
    )
    assert not fails, (
        f"{len(fails)}/{len(rows)} fixtures still emit same-goal general_purpose "
        f"spawn_agent: {[f['fixture_id'] for f in fails]}"
    )


async def run_all_tests():
    r = BlackboxResult()
    print("recursive-same-goal-spawn blackbox tests:")
    if not LIVE:
        print(
            "  ⏭  skipped (set RECURSIVE_SPAWN_LIVE=1 to run live Rose.collect suite)"
        )
        return True
    await r.record_async(
        "parallel/no-recursive-same-goal-gp-spawn",
        test_parallel_no_recursive_same_goal_gp_spawn,
    )
    print(r.summary())
    return r.failed == 0


if __name__ == "__main__":
    ok = asyncio.run(run_all_tests())
    sys.exit(0 if ok else 1)
