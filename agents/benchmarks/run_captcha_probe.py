"""CAPTCHA probe: run one production CAPTCHA site through the real Rose agent and
return a conclusive anti-bot verdict.

    POST /api/agents (plan -> execute -> browser agent)  ->  poll until terminal / cap
      -> DELETE the agent  ->  collect antibot.* + classifier log lines for its tree
      -> one Rose judge call (final transcript vs post_wall_evidence)
      -> decide_verdict()  ->  one JSON line

Verdicts: PASSED_CAPTCHA, FAILED_CAPTCHA, or INCONCLUSIVE (only when the agent
never reached the CAPTCHA point for a non-CAPTCHA reason, with that reason).
Pending questions and approvals end the run; nothing is ever approved.

Usage (from agents/, venv active, local stack running):
    python benchmarks/run_captcha_probe.py --base-url http://localhost:3001 google-search \
        --worker-log navi-worker-log.txt [--backend-log ../back-end/backend-logs.log] [--cap-minutes 30]
    python benchmarks/run_captcha_probe.py --list
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

SITES_PATH = Path(__file__).with_name("captcha_probe_sites.json")
DEFAULT_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"
TERMINAL_STATUSES = {"COMPLETED", "FAILED", "OUT_OF_CREDITS", "COST_LIMIT_REACHED"}
VERDICTS = ("PASSED_CAPTCHA", "FAILED_CAPTCHA", "INCONCLUSIVE")
LOG_EVENTS = ("antibot.episode", "antibot.stuck", "Challenge LLM classifier result")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

JUDGE_SYSTEM_PROMPT = """You judge one anti-bot probe. A Rose agent was sent to a live website to reach
the point where a CAPTCHA / bot wall appeared in production, and to stop right after it.

Decide from the evidence only (final browser pages, tool results, anti-bot log events):
- PASSED_CAPTCHA: the post-wall evidence was observed (the page past the wall loaded with its real
  content), whether a challenge appeared and was cleared or no challenge appeared at all.
- FAILED_CAPTCHA: a CAPTCHA, bot check, "unusual traffic", access-denied or challenge page was still
  blocking at the end, or challenge recovery was exhausted, so the post-wall evidence was never seen.
- INCONCLUSIVE: the agent never reached the CAPTCHA point for a reason that is NOT a challenge
  (for example it asked a question, needed a login or payment approval, chose a different site,
  crashed, or ran out of time before navigating there). Give that reason.
Assistant claims without page/tool evidence do not count.

Reply with JSON only: {"verdict": "PASSED_CAPTCHA|FAILED_CAPTCHA|INCONCLUSIVE",
"reason": "<one sentence>", "evidence_seen": "<the observed post-wall evidence, or empty>",
"challenge_seen": true|false}"""


def load_probes(path: Path = SITES_PATH) -> Dict[str, Dict[str, Any]]:
    data = json.loads(path.read_text())
    return {probe["name"]: probe for probe in data["probes"]}


# ── log collection ───────────────────────────────────────────────────────────


def _parse_log_line(line: str) -> Optional[Dict[str, Any]]:
    start = line.find("{")
    if start >= 0:
        try:
            parsed = json.loads(line[start:])
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            pass
    return {"event": line.strip(), "_raw": True}


def collect_antibot_events(lines: Iterable[str], agent_ids: Iterable[str]) -> List[Dict[str, Any]]:
    """antibot.episode / antibot.stuck / classifier lines that name one of ``agent_ids``."""
    ids = {agent_id for agent_id in agent_ids if agent_id}
    events: List[Dict[str, Any]] = []
    for line in lines:
        if not any(name in line for name in LOG_EVENTS) or not any(agent_id in line for agent_id in ids):
            continue
        parsed = _parse_log_line(line)
        if parsed is None:
            continue
        name = next(name for name in LOG_EVENTS if name in line)
        parsed["_event"] = name
        events.append(parsed)
    return events


def summarize_events(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    episodes = [event for event in events if event["_event"] == "antibot.episode"]
    stuck = [event for event in events if event["_event"] == "antibot.stuck"]
    classifier = [event for event in events if event["_event"] == "Challenge LLM classifier result"]
    recovery_failed = [
        episode
        for episode in episodes
        if str(episode.get("recovery_outcome") or "").startswith(("failed", "exhausted"))
    ]
    return {
        "episodes": len(episodes),
        "stuck": len(stuck),
        "recovery_failed": len(recovery_failed),
        "classifier_challenged": sum(1 for item in classifier if item.get("challenged") is True),
        "cleared": sum(1 for episode in episodes if episode.get("cleared") is True),
        "last_stuck_host": (stuck[-1].get("final_url_host") or stuck[-1].get("host")) if stuck else "",
    }


# ── verdict ──────────────────────────────────────────────────────────────────


def decide_verdict(judge: Dict[str, Any], summary: Dict[str, Any], end_reason: str) -> Dict[str, str]:
    """Combine the judge with the log evidence into one conclusive verdict.

    Log facts override the judge where they are unambiguous: an unresolved
    challenge at session end (antibot.stuck) cannot be a pass, and a judge
    INCONCLUSIVE is not accepted when the logs show challenge recovery failing
    or a challenge left blocking.
    """
    verdict = str(judge.get("verdict") or "").strip().upper()
    reason = str(judge.get("reason") or "").strip()
    evidence = str(judge.get("evidence_seen") or "").strip()
    if verdict not in VERDICTS:
        verdict = "INCONCLUSIVE"
        reason = reason or f"judge returned no valid verdict ({end_reason})"
    if summary.get("stuck") and verdict == "PASSED_CAPTCHA" and not evidence:
        return {"verdict": "FAILED_CAPTCHA", "reason": "challenge unresolved at session end (antibot.stuck)"}
    if summary.get("stuck") and verdict == "INCONCLUSIVE":
        return {
            "verdict": "FAILED_CAPTCHA",
            "reason": f"challenge unresolved at session end on {summary.get('last_stuck_host') or 'the site'}",
        }
    if summary.get("recovery_failed") and verdict == "INCONCLUSIVE" and not evidence:
        return {"verdict": "FAILED_CAPTCHA", "reason": "challenge recovery failed and the wall was never passed"}
    if verdict == "INCONCLUSIVE" and not reason:
        reason = end_reason or "agent did not reach the CAPTCHA point"
    return {"verdict": verdict, "reason": reason or end_reason}


# ── transcript evidence ──────────────────────────────────────────────────────


def _message_text(message: Dict[str, Any]) -> str:
    text = str(message.get("message") or message.get("content") or "")
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    extra = {key: metadata.get(key) for key in ("toolName", "title", "browserUrl", "resumeUrl", "recoveryStage") if metadata.get(key)}
    return (json.dumps(extra) + " " if extra else "") + text


def compact_transcript(messages: List[Dict[str, Any]], limit: int = 60, chars: int = 1500) -> List[Dict[str, str]]:
    return [{"role": str(message.get("role") or ""), "text": _message_text(message)[:chars]} for message in messages[-limit:]]


def tree_agent_ids(root_id: str, payloads: Iterable[Any], exclude: Iterable[str] = ()) -> List[str]:
    """Root plus every id named in its transcripts (spawned agents), minus ``exclude`` (the user id,
    which would otherwise match every other agent's log lines)."""
    ids = {root_id}
    for payload in payloads:
        ids.update(_UUID.findall(json.dumps(payload, default=str)))
    return sorted(ids - set(exclude))


# ── live run ─────────────────────────────────────────────────────────────────


def _agent_payload(data: Any) -> Dict[str, Any]:
    """GET /api/agents/:id body as one dict with status and messages, across response shapes."""
    if not isinstance(data, dict):
        return {}
    agent = dict(data.get("agent") or {}) if isinstance(data.get("agent"), dict) else dict(data)
    if "messages" not in agent and isinstance(data.get("messages"), list):
        agent["messages"] = data["messages"]
    return agent


def _headers(user_id: str) -> Dict[str, str]:
    key = os.getenv("BACKEND_API_KEY") or ""
    if not key:
        raise SystemExit("BACKEND_API_KEY is required (load agents/.env)")
    return {"X-API-Key": key, "X-User-Id": user_id, "Content-Type": "application/json"}


def _open_attention(requests: Any, agent_ids: Iterable[str]) -> List[Dict[str, Any]]:
    items = requests.get("requests") if isinstance(requests, dict) else requests
    ids = set(agent_ids)
    open_items = []
    for item in items or []:
        if not isinstance(item, dict) or item.get("answered") is True or item.get("response") is not None:
            continue
        if ids & set(_UUID.findall(json.dumps(item, default=str))):
            open_items.append(item)
    return open_items


async def _judge(probe: Dict[str, Any], transcript: List[Dict[str, str]], summary: Dict[str, Any], end_reason: str, user_id: str) -> Dict[str, Any]:
    from helpers.llm import _build_compute_auth_context, fetch_compute_token_activity
    from providers.rose import RoseClient
    from providers.rose.types import ClaudeAuthContext, GptAuthContext

    lease = await fetch_compute_token_activity(user_id)
    auth = _build_compute_auth_context(lease or {}, user_id) if lease else None
    evidence = {
        "site": probe["site"],
        "where_captcha_hit_in_production": probe["where_captcha_hit"],
        "post_wall_evidence_required": probe["post_wall_evidence"],
        "probe_goal": probe["goal"],
        "run_end": end_reason,
        "antibot_log_summary": summary,
        "final_transcript": transcript,
    }
    response = await RoseClient().collect(
        pool="rose-1-ultra",
        messages=[
            {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(evidence, default=str)},
        ],
        json_mode=True,
        claude_auth=auth if isinstance(auth, ClaudeAuthContext) else None,
        gpt_auth=auth if isinstance(auth, GptAuthContext) else None,
        call_site="captcha_probe_judge",
    )
    content = (response.content or "").strip()
    match = re.search(r"\{.*\}", content, re.S)
    try:
        judged = json.loads(match.group(0) if match else content)
    except ValueError:
        judged = {"verdict": "", "reason": f"unparseable judge reply: {content[:160]}"}
    judged["_model"] = response.actual_model
    return judged


async def run_probe(args: argparse.Namespace, probe: Dict[str, Any]) -> Dict[str, Any]:
    import httpx

    base = args.base_url.rstrip("/")
    headers = _headers(args.user_id)
    goal = probe["goal"].replace("{frontend_url}", args.frontend_url or base)
    started = time.time()
    async with httpx.AsyncClient(timeout=60) as client:
        created = await client.post(f"{base}/api/agents", headers=headers, json={"goal": goal, "start_phase": "plan"})
        created.raise_for_status()
        body = created.json()
        agent_id = body.get("id") or body.get("agent_id") or (body.get("agent") or {}).get("id")
        deadline = time.monotonic() + args.cap_minutes * 60
        end_reason, agent, status = "cap reached", {}, ""
        try:
            while True:
                response = await client.get(f"{base}/api/agents/{agent_id}", headers=headers)
                if response.status_code == 200:
                    agent = _agent_payload(response.json())
                    status = str(agent.get("status") or "")
                    if status in TERMINAL_STATUSES:
                        end_reason = f"agent {status}"
                        break
                    ids = tree_agent_ids(agent_id, [agent.get("messages") or []], [args.user_id])
                    attention = await client.get(f"{base}/api/attention-requests", headers=headers)
                    pending = _open_attention(attention.json() if attention.status_code == 200 else [], ids)
                    if pending:
                        title = str((pending[0].get("metadata") or {}).get("title") or pending[0].get("message") or "")[:160]
                        end_reason = f"pending question/approval (not approved): {title}"
                        break
                if time.monotonic() > deadline:
                    break
                await asyncio.sleep(args.poll_seconds)
        finally:
            messages = list(agent.get("messages") or [])
            ids = tree_agent_ids(agent_id, [messages], [args.user_id])
            # Spawned (browser) agents keep their own transcripts; read them before deleting the root.
            for child_id in [child for child in ids if child != agent_id][:15]:
                child = await client.get(f"{base}/api/agents/{child_id}", headers=headers)
                if child.status_code == 200:
                    messages.extend(_agent_payload(child.json()).get("messages") or [])
            await client.delete(f"{base}/api/agents/{agent_id}", headers=headers)
    ids = tree_agent_ids(agent_id, [messages], [args.user_id])
    lines: List[str] = []
    for path in filter(None, [args.worker_log, args.backend_log]):
        with open(path, errors="replace") as handle:
            lines.extend(handle)
    events = collect_antibot_events(lines, ids)
    summary = summarize_events(events)
    judged = await _judge(probe, compact_transcript(messages), summary, end_reason, args.user_id)
    decided = decide_verdict(judged, summary, end_reason)
    return {
        "probe": probe["name"],
        "site": probe["site"],
        "verdict": decided["verdict"],
        "reason": decided["reason"],
        "evidence_seen": judged.get("evidence_seen") or "",
        "agent_id": agent_id,
        "fe_link": f"{(args.frontend_url or base)}/?agent-id={agent_id}",
        "end": end_reason,
        "antibot": summary,
        "judge_model": judged.get("_model", ""),
        "duration_s": round(time.time() - started, 1),
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("probe", nargs="?")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--base-url", default="http://localhost:3001")
    parser.add_argument("--frontend-url", default="", help="FE origin for links and {frontend_url} goals (default: base URL)")
    parser.add_argument("--worker-log", default="navi-worker-log.txt")
    parser.add_argument("--backend-log", default="")
    parser.add_argument("--cap-minutes", type=float, default=30.0)
    parser.add_argument("--poll-seconds", type=float, default=10.0)
    parser.add_argument("--user-id", default=DEFAULT_USER_ID)
    parser.add_argument("--include-held", action="store_true", help="run a probe marked hold")
    args = parser.parse_args(argv)
    probes = load_probes()
    if args.list or not args.probe:
        for probe in probes.values():
            print(f"{probe['name']:32} {'HOLD ' if probe['hold'] else '     '}{probe['site']}")
        return 0
    probe = probes.get(args.probe)
    if probe is None:
        print(f"unknown probe {args.probe!r}; see --list", file=sys.stderr)
        return 2
    if probe["hold"] and not args.include_held:
        print(json.dumps({"probe": probe["name"], "site": probe["site"], "verdict": "HELD", "reason": probe.get("hold_reason", "")}))
        return 0
    os.environ.setdefault("BACKEND_API_URL", args.base_url)
    result = asyncio.run(run_probe(args, probe))
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
