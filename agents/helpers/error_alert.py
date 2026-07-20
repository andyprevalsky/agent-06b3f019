"""Direct-to-Slack failure alerting for the agent worker.

DESIGN — mirrors back-end/src/providers/errorAlert.ts. This path deliberately
does NOT call our own backend: the failures we most want to hear about are the
ones where the backend/DB is unhealthy, so alerting through it would go silent
exactly when it matters. `report_failure_activity` posts straight to a Slack
incoming webhook, and — only when AUTO_RCA_ENABLED=1 — fires a GitHub
repository_dispatch straight to GitHub's API.

Dedup is an in-memory per-process throttle (no DB, no shared state): the same
signature pages at most once per _THROTTLE_WINDOW_S per worker process. This is
best-effort noise control, not correctness — a retry landing on a different
worker may emit a duplicate, which is acceptable. The activity NEVER raises:
alerting must not disrupt the agent failure path, and Temporal's at-least-once
retries are naturally deduped by the throttle.
"""

import os
import re
import threading
import time
from typing import Any, Dict, Optional

import httpx
from temporalio import activity

_THROTTLE_WINDOW_S = 300
_MAX_THROTTLE_ENTRIES = 5000
_OUTBOUND_TIMEOUT_S = 8.0

_FE_BASE = os.environ.get("PUBLIC_FRONTEND_URL", "https://roselabs.ai")
_PROD_BACKEND = "https://navi-j9a9.onrender.com"

_SOURCE_LABEL = {
    "agent_workflow": "🔴 Agent failed",
    "chat": "🔴 Chat loop failed",
    "sms": "🔴 SMS agent failed",
    "agent_watchdog": "🔴 Agent stuck / silently died",
}

_last_sent: Dict[str, float] = {}
_lock = threading.Lock()


def _fingerprint(source: str, message: str) -> str:
    n = message.lower()
    n = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<uuid>", n)
    n = re.sub(r"0x[0-9a-f]+", "<hex>", n)
    n = re.sub(r"\d+", "<n>", n)
    n = re.sub(r"\s+", " ", n).strip()[:200]
    return f"{source}:{n}"


def _throttled(key: str, now: float) -> bool:
    with _lock:
        prev = _last_sent.get(key)
        if prev is not None and now - prev < _THROTTLE_WINDOW_S:
            return True
        _last_sent[key] = now
        if len(_last_sent) > _MAX_THROTTLE_ENTRIES:
            stale = [k for k, t in _last_sent.items() if now - t > _THROTTLE_WINDOW_S]
            for k in stale:
                _last_sent.pop(k, None)
        return False


def _slack_payload(source: str, message: str, agent_id: Optional[str]) -> Dict[str, Any]:
    label = _SOURCE_LABEL.get(source, "🔴 Failure")
    fields = [{"type": "mrkdwn", "text": f"*Source:*\n{source}"}]
    if agent_id:
        fields.append({"type": "mrkdwn", "text": f"*Agent:*\n`{agent_id}`"})

    blocks: list[Dict[str, Any]] = [
        {"type": "header", "text": {"type": "plain_text", "text": label}},
        {"type": "section", "text": {"type": "mrkdwn", "text": "```" + message[:600] + "```"}},
        {"type": "section", "fields": fields},
    ]
    if agent_id:
        fe_link = f"{_FE_BASE}/?agent-id={agent_id}"
        diag = (
            f"cd agents && python benchmarks/agent_logs.py {agent_id} "
            f"--url {_PROD_BACKEND} --tree --diagnostics"
        )
        blocks.append(
            {"type": "section", "text": {"type": "mrkdwn", "text": f"<{fe_link}|Open agent in the app>"}}
        )
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": f"`{diag}`"}]})

    return {"text": f"{label}: {message[:140]}", "blocks": blocks}


async def _post_slack_bot(
    token: str, channel: str, payload: Dict[str, Any]
) -> Optional[Dict[str, str]]:
    """Post the initial card via chat.postMessage and return {ts, channel}.

    A bot-token post (unlike an incoming webhook) yields an editable message
    handle so the RCA workflow can evolve one card through its lifecycle.
    Returns None if the post didn't land. Never raises.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://slack.com/api/chat.postMessage",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            json={"channel": channel, **payload},
            timeout=_OUTBOUND_TIMEOUT_S,
        )
    # Slack answers HTTP 200 even on logical errors — the truth is in `ok`.
    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    if not data.get("ok"):
        activity.logger.warning(f"Slack chat.postMessage not ok: {data.get('error')}")
        return None
    return {"ts": data.get("ts", ""), "channel": data.get("channel", channel)}


async def _dispatch_rca(
    agent_id: str,
    source: str,
    message: str,
    slack_ts: str = "",
    slack_channel: str = "",
) -> None:
    token = os.environ.get("GITHUB_DISPATCH_TOKEN")
    repo = os.environ.get("GITHUB_DISPATCH_REPO", "Rose-Ai-Labs/rose")
    if not token:
        activity.logger.warning("AUTO_RCA_ENABLED but GITHUB_DISPATCH_TOKEN unset — RCA not dispatched")
        return
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"https://api.github.com/repos/{repo}/dispatches",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "rose-error-alert",
            },
            json={
                "event_type": "agent-failure",
                "client_payload": {
                    "agent_id": agent_id,
                    "source": source,
                    "title": message[:120],
                    "slack_ts": slack_ts,
                    "slack_channel": slack_channel,
                },
            },
            timeout=_OUTBOUND_TIMEOUT_S,
        )
        if resp.status_code >= 300:
            activity.logger.warning(f"RCA dispatch non-2xx: {resp.status_code} {resp.text[:200]}")
        else:
            activity.logger.info(f"RCA agent dispatched: source={source} agent_id={agent_id}")


@activity.defn
async def report_failure_activity(
    agent_id: Optional[str],
    source: str,
    message: str,
    context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Emit an agent failure to #errors (and, when AUTO_RCA_ENABLED=1, launch RCA).

    Best-effort — always returns, never raises. Deduped by the in-memory throttle.
    """
    try:
        now = time.time()
        if _throttled(_fingerprint(source, message), now):
            return {"alerted": False, "throttled": True}

        payload = _slack_payload(source, message, agent_id)
        bot_token = os.environ.get("SLACK_BOT_TOKEN")
        channel_id = os.environ.get("SLACK_ERROR_CHANNEL_ID")
        webhook = os.environ.get("SLACK_ERROR_WEBHOOK_URL")

        # Prefer the bot token: it yields an editable handle for the lifecycle card.
        # Fall back to an incoming webhook (post-only, no lifecycle edits).
        slack_ts = ""
        slack_channel = ""
        alerted = False
        if bot_token and channel_id:
            posted = await _post_slack_bot(bot_token, channel_id, payload)
            if posted:
                slack_ts = posted["ts"]
                slack_channel = posted["channel"]
                alerted = True
        elif webhook:
            async with httpx.AsyncClient() as client:
                resp = await client.post(webhook, json=payload, timeout=_OUTBOUND_TIMEOUT_S)
                if resp.status_code >= 300:
                    activity.logger.warning(f"Slack alert non-2xx: {resp.status_code} {resp.text[:200]}")
                else:
                    alerted = True
        else:
            activity.logger.warning(
                f"No Slack sink configured — failure observed but not alerted: "
                f"source={source} agent_id={agent_id} message={message[:200]}"
            )

        if os.environ.get("AUTO_RCA_ENABLED") == "1" and agent_id:
            await _dispatch_rca(agent_id, source, message, slack_ts, slack_channel)

        return {"alerted": alerted}
    except Exception as e:  # never fail the agent because alerting failed
        activity.logger.warning(f"report_failure_activity non-fatal: {e}")
        return {"alerted": False, "error": str(e)}
