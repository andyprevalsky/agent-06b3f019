"""CAPTCHA probe: run one production CAPTCHA site through the real Rose agent and
return a conclusive anti-bot verdict.

    POST /api/agents (plan -> execute -> browser agent)  ->  poll until terminal / cap
      -> DELETE the agent  ->  collect antibot.* + classifier log lines for its tree
      -> one Rose judge call (final answer + final tab URLs/titles + last browser
         snapshots + post_wall_evidence; see build_judge_evidence)
      -> decide_verdict()  ->  one JSON line (verdict + confidence)

Every run saves its transcripts under --save-dir; `--rejudge <file>` re-grades a saved
transcript (or a GET /api/agents/:id / benchmark record JSON) without rerunning the probe.

Verdicts: PASSED_CAPTCHA, FAILED_CAPTCHA, or INCONCLUSIVE (only when the agent
never reached the CAPTCHA point for a non-CAPTCHA reason, with that reason).
Pending questions and approvals end the run; nothing is ever approved.

Usage (from agents/, venv active, local stack running):
    python benchmarks/run_captcha_probe.py --base-url http://localhost:3001 google-search \
        --worker-log navi-worker-log.txt [--backend-log ../back-end/backend-logs.log] [--cap-minutes 30]
    Stacks with several workers split logs across worker.log and worker.1..N.log: pass
    --stack-log-dir <run-bench context dir, its logs/ dir, or a run.sh checkout root>,
    or repeat --worker-log / give a glob such as --worker-log '<dir>/worker*.log'.
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

# Run as `python benchmarks/run_captcha_probe.py` from agents/: put agents/ on sys.path so the
# judge can import helpers/ and providers/ without PYTHONPATH.
_AGENTS_DIR = str(Path(__file__).resolve().parents[1])
if _AGENTS_DIR not in sys.path:
    sys.path.insert(0, _AGENTS_DIR)

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

The evidence object holds: agent_final_answer (may be terse; it is not proof either way),
browser_tabs_at_end_most_recent_last (final URL and title per tab), last_browser_observations
(truncated page snapshots; the visible page text is the proof), recent_browser_actions, the
antibot log summary, and post_wall_evidence_required. A terse final answer does not make a run
INCONCLUSIVE when the final browser snapshots show the post-wall evidence.

Reply with JSON only: {"verdict": "PASSED_CAPTCHA|FAILED_CAPTCHA|INCONCLUSIVE",
"reason": "<one sentence>", "evidence_seen": "<the observed post-wall evidence, or empty>",
"challenge_seen": true|false, "confidence": "high|medium|low"}
confidence is low when the snapshots are missing, stale or contradict each other."""


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
    # Patience: the provider's own auto-solve cleared it while we waited. Recovery: the recovery path
    # (config_selected, cookie fix, ...) ran and succeeded. Both are clears; a recovery success has
    # cleared=False in the episode, so counting only `cleared` made it look like nothing happened.
    by_patience = [
        episode
        for episode in episodes
        if episode.get("recovery_outcome") == "cleared_after_patience" or episode.get("cleared") is True
    ]
    by_recovery = [
        episode
        for episode in episodes
        if episode not in by_patience
        and episode.get("recovery_invoked") is True
        and str(episode.get("recovery_outcome") or "")
        and episode not in recovery_failed
        and not str(episode.get("recovery_outcome")).startswith("failed")
    ]
    return {
        "episodes": len(episodes),
        "stuck": len(stuck),
        "recovery_failed": len(recovery_failed),
        "classifier_challenged": sum(1 for item in classifier if item.get("challenged") is True),
        "cleared": len(by_patience) + len(by_recovery),
        "cleared_by_patience": len(by_patience),
        "cleared_by_recovery": len(by_recovery),
        "last_stuck_host": (stuck[-1].get("final_url_host") or stuck[-1].get("host")) if stuck else "",
    }


# ── verdict ──────────────────────────────────────────────────────────────────


def decide_verdict(judge: Dict[str, Any], summary: Dict[str, Any], end_reason: str) -> Dict[str, str]:
    result = _decide_verdict(judge, summary, end_reason)
    result["confidence"] = _confidence(judge, summary, result)
    return result


def _confidence(judge: Dict[str, Any], summary: Dict[str, Any], result: Dict[str, str]) -> str:
    """Judge-stated confidence, lowered when the verdict came from a log override or rests on
    no observed evidence."""
    stated = str(judge.get("confidence") or "").strip().lower()
    level = stated if stated in ("high", "medium", "low") else "low"
    if result["verdict"] == "PASSED_CAPTCHA" and not str(judge.get("evidence_seen") or "").strip():
        level = "low"
    overridden = str(judge.get("verdict") or "").strip().upper() != result["verdict"]
    if overridden and level == "high":
        level = "medium"
    return level


def _decide_verdict(judge: Dict[str, Any], summary: Dict[str, Any], end_reason: str) -> Dict[str, str]:
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


_OBSERVATION_TOOLS = {"read_browser_state"}
_FINAL_ANSWER_CHARS = 4000
_OBSERVATION_COUNT = 6
_OBSERVATION_CHARS = 4000
_ACTION_TRAIL = 15


def _metadata(message: Dict[str, Any]) -> Dict[str, Any]:
    metadata = message.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _message_url(message: Dict[str, Any]) -> str:
    metadata = _metadata(message)
    for key in ("browser_url", "browserUrl", "resumeUrl", "current_url"):
        if metadata.get(key):
            return str(metadata[key])
    return ""


def _message_body(message: Dict[str, Any]) -> str:
    return str(message.get("text") or message.get("message") or message.get("content") or "")


# On a real stack the Message row's own text is often empty for TOOL / ASSISTANT rows; what the agent
# said and what the page showed lives in metadata (sendMessageToUser, summary/output, attentionMessage,
# sources, tool output, extracted page text ...). Harvest every readable string there; skip bookkeeping.
_METADATA_PRIORITY = (
    "sendMessageToUser", "summary", "completionSummary", "output", "result", "attentionMessage",
    "message", "content", "pageText", "page_text", "observation", "browser_state", "state", "sources",
)
_METADATA_SKIP = {
    "toolCallId", "tool_call_id", "task_id", "taskId", "subAgentId", "sub_agent_id", "toolStatus", "agentType",
    "auxiliary", "output_schema", "browser_session_metadata", "credential_ref", "steps_taken", "total_steps",
    "screenshot", "screenshots", "image", "images", "coordinates", "workflowGeneration", "usage", "cost",
}
_ROW_TEXT_CHARS = 12000


def _is_noise(value: str) -> bool:
    if value.startswith(("data:", "blob:")):
        return True
    return len(value) > 200 and " " not in value[:200]  # base64 / opaque blobs


def _harvest_strings(value: Any, path: str, out: List[tuple], depth: int = 0) -> None:
    if depth > 6:
        return
    if isinstance(value, str):
        text = value.strip()
        if len(text) >= 3 and not _is_noise(text):
            out.append((path, text))
    elif isinstance(value, dict):
        for key, item in value.items():
            if key in _METADATA_SKIP or str(key).lower().endswith(("token", "secret", "password")):
                continue
            _harvest_strings(item, f"{path}.{key}" if path else str(key), out, depth + 1)
    elif isinstance(value, list):
        for item in value[:50]:
            _harvest_strings(item, path, out, depth + 1)


def _row_text(message: Dict[str, Any]) -> str:
    """Everything readable in one message row: its text plus every metadata string that carries
    agent or page text, highest-signal fields first. Not truncated per field, only per row."""
    parts: List[str] = []
    body = _message_body(message).strip()
    if body:
        parts.append(body)
    found: List[tuple] = []
    _harvest_strings(_metadata(message), "", found)
    structural = {"toolName", "title", "browser_url", "browserUrl", "resumeUrl", "action_type", "recoveryStage"}

    def rank(item: tuple) -> int:
        leaf = item[0].split(".")[-1]
        return _METADATA_PRIORITY.index(leaf) if leaf in _METADATA_PRIORITY else len(_METADATA_PRIORITY)

    seen = {body}
    for path, text in sorted(found, key=rank):
        if path.split(".")[-1] in structural or text in seen:
            continue
        seen.add(text)
        parts.append(f"{path}: {text}")
    return _keep_head_and_tail("\n".join(parts), _ROW_TEXT_CHARS)  # the end of a page snapshot is its final state


def _message_text(message: Dict[str, Any]) -> str:
    metadata = _metadata(message)
    extra = {
        key: metadata[key]
        for key in ("toolName", "title", "browser_url", "browserUrl", "resumeUrl", "recoveryStage", "action_type")
        if metadata.get(key)
    }
    return (json.dumps(extra) + " " if extra else "") + _row_text(message)


def compact_transcript(messages: List[Dict[str, Any]], limit: int = 60, chars: int = 1500) -> List[Dict[str, str]]:
    return [{"role": str(message.get("role") or ""), "text": _message_text(message)[:chars]} for message in messages[-limit:]]


def _keep_head_and_tail(text: str, chars: int) -> str:
    """Truncate a page snapshot without dropping its end (where the final state usually is)."""
    if len(text) <= chars:
        return text
    head = chars // 3
    return text[:head] + "\n...[truncated]...\n" + text[-(chars - head) :]


def build_judge_evidence(root_messages: List[Dict[str, Any]], child_messages: List[Dict[str, Any]]) -> Dict[str, Any]:
    """What the judge sees, built so a terse final answer cannot starve it.

    The root transcript and the browser (child) transcripts are budgeted separately: the root's
    final answer is never pushed out by a long browser run. Browser observations are kept as
    truncated snapshots (head + tail), not dropped.
    """
    root_rows = [(m, _row_text(m)) for m in root_messages]
    answers = [text for m, text in root_rows if str(m.get("role") or "").upper() == "ASSISTANT" and text.strip()]
    if not answers:  # fall back to the last agent-authored root row of any non-user role
        answers = [text for m, text in root_rows if str(m.get("role") or "").upper() not in ("USER", "SYSTEM") and text.strip()]
    final_answer = answers[-1][:_FINAL_ANSWER_CHARS] if answers else ""
    # The root's own tool results include the browser agent's completion summary.
    root_tool_results = [
        {"tool": _metadata(m).get("toolName") or "", "text": text[:2000]}
        for m, text in root_rows
        if str(m.get("role") or "").upper() == "TOOL" and text.strip()
    ][-4:]

    child_rows = [(m, _row_text(m)) for m in child_messages]
    browser = [(m, text) for m, text in child_rows if text.strip() or _message_url(m)]
    tabs: List[Dict[str, str]] = []
    seen_urls = set()
    for message, _text in reversed(browser):
        url = _message_url(message)
        if url and url not in seen_urls:
            seen_urls.add(url)
            tabs.append({"url": url, "title": str(_metadata(message).get("title") or "")[:200]})
        if len(tabs) >= 8:
            break
    tabs.reverse()
    observations = [
        (m, text)
        for m, text in browser
        if _metadata(m).get("toolName") in _OBSERVATION_TOOLS or len(text) >= 200
    ][-_OBSERVATION_COUNT:]
    return {
        "agent_final_answer": final_answer,
        "root_recent_tool_results": root_tool_results,
        "browser_tabs_at_end_most_recent_last": tabs,
        "last_browser_observations": [
            {
                "tool": _metadata(m).get("toolName") or "",
                "url": _message_url(m),
                "title": str(_metadata(m).get("title") or "")[:200],
                "text": _keep_head_and_tail(text, _OBSERVATION_CHARS),
            }
            for m, text in observations
        ],
        "recent_browser_actions": [
            {"action": _metadata(m).get("action_type") or _metadata(m).get("toolName") or "", "text": text[:240]}
            for m, text in browser[-_ACTION_TRAIL:]
        ],
        "root_transcript_tail": compact_transcript(root_messages, limit=12, chars=800),
    }


def tree_agent_ids(root_id: str, payloads: Iterable[Any], exclude: Iterable[str] = ()) -> List[str]:
    """Root plus every id named in its transcripts (spawned agents), minus ``exclude`` (the user id,
    which would otherwise match every other agent's log lines)."""
    ids = {root_id}
    for payload in payloads:
        ids.update(_UUID.findall(json.dumps(payload, default=str)))
    return sorted(ids - set(exclude))


# ── live run ─────────────────────────────────────────────────────────────────


def log_paths(worker_logs: Iterable[str], backend_logs: Iterable[str], log_dir: str = "") -> List[Path]:
    """Every log file to scan. Each pattern may be a glob; ``log_dir`` adds its worker*/backend* logs.

    A multi-worker stack writes worker.log plus worker.1..N.log, and the episode for a
    probe lands in whichever worker ran its activity, so all of them must be read."""
    patterns = [pattern for pattern in [*worker_logs, *backend_logs] if pattern]
    if log_dir:
        root = Path(log_dir)
        # run-bench isolated stack: <ctx>/logs/{worker*.log,backend.log}; run.sh checkout:
        # agents/navi-worker-log.txt + back-end/backend-logs.log.
        for sub in ("", "logs/"):
            patterns += [str(root / f"{sub}worker*.log"), str(root / f"{sub}backend*.log")]
        patterns += [str(root / "agents" / "navi-worker-log*.txt"), str(root / "back-end" / "backend-logs*.log")]
    found: List[Path] = []
    for pattern in patterns:
        matches = sorted(Path().glob(pattern)) if not Path(pattern).is_absolute() else sorted(
            Path(pattern).parent.glob(Path(pattern).name)
        )
        if not matches and not any(char in pattern for char in "*?["):
            raise SystemExit(f"log file not found: {pattern}")
        for match in matches:
            if match.is_file() and match not in found:
                found.append(match)
    if not found:
        raise SystemExit("no worker/backend logs found; pass --log-dir or --worker-log")
    return found


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


async def _judge(probe: Dict[str, Any], observed: Dict[str, Any], summary: Dict[str, Any], end_reason: str, user_id: str) -> Dict[str, Any]:
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
        **observed,
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
            root_messages = list(agent.get("messages") or [])
            child_messages: List[Dict[str, Any]] = []
            ids = tree_agent_ids(agent_id, [root_messages], [args.user_id])
            # Spawned (browser) agents keep their own transcripts; read them before deleting the root.
            for child_id in [child for child in ids if child != agent_id][:15]:
                child = await client.get(f"{base}/api/agents/{child_id}", headers=headers)
                if child.status_code == 200:
                    child_messages.extend(_agent_payload(child.json()).get("messages") or [])
            await client.delete(f"{base}/api/agents/{agent_id}", headers=headers)
    ids = tree_agent_ids(agent_id, [root_messages, child_messages], [args.user_id])
    summary = summarize_events(collect_antibot_events(_read_log_lines(args), ids))
    saved = save_run(
        args.save_dir,
        {
            "probe": probe["name"],
            "agent_id": agent_id,
            "end_reason": end_reason,
            "antibot": summary,
            "root_messages": root_messages,
            "child_messages": child_messages,
        },
    )
    result = await grade(probe, root_messages, child_messages, summary, end_reason, args.user_id)
    result.update(
        agent_id=agent_id,
        fe_link=_fe_link(args, agent_id),
        saved_transcript=str(saved),
        duration_s=round(time.time() - started, 1),
    )
    return result


async def grade(
    probe: Dict[str, Any],
    root_messages: List[Dict[str, Any]],
    child_messages: List[Dict[str, Any]],
    summary: Dict[str, Any],
    end_reason: str,
    user_id: str,
    judge: Any = None,
) -> Dict[str, Any]:
    """One judge call over build_judge_evidence + the log-override rules -> the result line."""
    observed = build_judge_evidence(root_messages, child_messages)
    judged = await (judge or _judge)(probe, observed, summary, end_reason, user_id)
    decided = decide_verdict(judged, summary, end_reason)
    return {
        "probe": probe["name"],
        "site": probe["site"],
        "verdict": decided["verdict"],
        "confidence": decided["confidence"],
        "reason": decided["reason"],
        "evidence_seen": judged.get("evidence_seen") or "",
        "end": end_reason,
        "antibot": summary,
        "judge_model": judged.get("_model", ""),
        "judge_input": {
            "final_answer_chars": len(observed["agent_final_answer"]),
            "tabs": len(observed["browser_tabs_at_end_most_recent_last"]),
            "observations": len(observed["last_browser_observations"]),
        },
    }


def _read_log_lines(args: argparse.Namespace) -> List[str]:
    lines: List[str] = []
    for path in log_paths(args.worker_log, args.backend_log, args.log_dir):
        with open(path, errors="replace") as handle:
            lines.extend(handle)
    return lines


def _fe_link(args: argparse.Namespace, agent_id: str) -> str:
    """The FE link for the agent. Dev stacks serve the FE on backend port + 1 (run.sh)."""
    frontend = args.frontend_url.rstrip("/")
    if not frontend:
        match = re.match(r"^(https?://[^/:]+):(\d+)$", args.base_url.rstrip("/"))
        frontend = f"{match.group(1)}:{int(match.group(2)) + 1}" if match else args.base_url.rstrip("/")
    return f"{frontend}/?agent-id={agent_id}"


def save_run(save_dir: str, record: Dict[str, Any]) -> Path:
    """Persist the transcripts a verdict was graded from so it can be re-graded with --rejudge."""
    directory = Path(save_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{record['probe']}-{str(record.get('agent_id') or 'run')[:8]}.json"
    path.write_text(json.dumps(record, default=str))
    return path


def _agent_nodes(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Agent nodes ({id, parent?, messages}) from an exported tree in any of the shapes the lanes use:
    ``agents`` / ``tree`` as a list or id->node dict, or the benchmark record's ``_benchmark.tree``."""
    for container in (data.get("agents"), data.get("tree"), (data.get("_benchmark") or {}).get("tree")):
        if isinstance(container, dict) and container:
            return [dict(node, id=node.get("id") or node.get("agent_id") or key) for key, node in container.items() if isinstance(node, dict)]
        if isinstance(container, list) and container:
            return [node for node in container if isinstance(node, dict)]
    return []


def load_saved_run(path: str, probe_names: Iterable[str] = ()) -> Dict[str, Any]:
    """Root + browser transcripts, probe name and antibot summary (if recorded) from a saved probe
    run (--save-dir), a lane's exported agent tree, or a raw GET /api/agents/:id / benchmark record."""
    data = json.loads(Path(path).read_text())
    if isinstance(data, list):
        data = {"messages": data}
    probe = str(data.get("probe") or data.get("probe_name") or "")
    if not probe:  # lane exports are named <probe>.<attempt>.json / <probe>-<stamp>.json
        stem = Path(path).name
        matches = [name for name in probe_names if stem.startswith(name)]
        probe = max(matches, key=len) if matches else ""
    loaded = {"probe": probe, "end_reason": str(data.get("end_reason") or "rejudge of saved transcript"), "antibot": data.get("antibot")}
    if "root_messages" in data or "child_messages" in data:
        return {**loaded, "root": list(data.get("root_messages") or []), "children": list(data.get("child_messages") or [])}
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else data
    root_id = str(data.get("root_agent_id") or data.get("rootAgentId") or agent.get("id") or agent.get("agent_id") or "")
    nodes = _agent_nodes(data)
    if nodes:
        def is_root(node: Dict[str, Any]) -> bool:
            node_id = str(node.get("id") or node.get("agent_id") or "")
            return node_id == root_id if root_id else not (node.get("parentId") or node.get("parent_id") or node.get("parent"))

        roots = [node for node in nodes if is_root(node)] or nodes[:1]
        root_messages = list(roots[0].get("messages") or [])
        children: List[Dict[str, Any]] = []
        for node in nodes:
            if node is not roots[0]:
                children.extend(node.get("messages") or [])
        return {**loaded, "root": root_messages, "children": children}
    messages = list(agent.get("messages") or data.get("messages") or [])
    # A flat transcript: rows from the browser agent carry its URL or task id.
    children = [m for m in messages if _message_url(m) or _metadata(m).get("task_id")]
    return {**loaded, "root": [m for m in messages if m not in children], "children": children}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("probe", nargs="?")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--base-url", default="http://localhost:3001")
    parser.add_argument("--frontend-url", default="", help="FE origin for links and {frontend_url} goals (default: base URL)")
    parser.add_argument("--worker-log", action="append", default=[], help="repeatable; globs allowed")
    parser.add_argument("--backend-log", action="append", default=[], help="repeatable; globs allowed")
    parser.add_argument(
        "--stack-log-dir",
        "--log-dir",
        dest="log_dir",
        default="",
        help="run-bench context dir (or its logs/) or run.sh checkout root: reads every worker and backend log",
    )
    parser.add_argument("--save-dir", default=".context/captcha-probe-runs", help="where each run's transcripts are saved")
    parser.add_argument(
        "--rejudge",
        metavar="FILE",
        help="re-grade a saved transcript (a --save-dir file, GET /api/agents/:id JSON or benchmark run record); no agent is run",
    )
    parser.add_argument("--cap-minutes", type=float, default=30.0)
    parser.add_argument("--poll-seconds", type=float, default=10.0)
    parser.add_argument("--user-id", default=DEFAULT_USER_ID)
    parser.add_argument("--include-held", action="store_true", help="run a probe marked hold")
    args = parser.parse_args(argv)
    probes = load_probes()
    if args.rejudge:
        saved = load_saved_run(args.rejudge, probes)
        name = args.probe or saved["probe"]
        if name not in probes:
            print(f"--rejudge needs a probe name (positional); got {name!r}", file=sys.stderr)
            return 2
        summary, antibot_source = saved["antibot"], "file"
        if args.worker_log or args.log_dir:
            # Re-derive the antibot.* summary for this tree from the stack logs.
            ids = tree_agent_ids("", [saved["root"], saved["children"]], [args.user_id])
            summary, antibot_source = summarize_events(collect_antibot_events(_read_log_lines(args), ids)), "logs"
        if summary is None:
            # No recorded or re-derived log facts: the judge decides alone (no antibot overrides).
            summary, antibot_source = summarize_events([]), "none"
        os.environ.setdefault("BACKEND_API_URL", args.base_url)
        result = asyncio.run(grade(probes[name], saved["root"], saved["children"], summary, saved["end_reason"], args.user_id))
        result.update(rejudged=True, source=args.rejudge, antibot_source=antibot_source)
        print(json.dumps(result), flush=True)
        return 0
    if not args.worker_log and not args.log_dir:
        args.worker_log = ["navi-worker-log.txt"]
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
