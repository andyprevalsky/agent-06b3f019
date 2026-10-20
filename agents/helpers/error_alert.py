"""Direct-to-Slack failure alerting for the agent worker.

DESIGN — mirrors back-end/src/providers/errorAlert.ts. This path deliberately
does NOT call our own backend: the failures we most want to hear about are the
ones where the backend/DB is unhealthy, so alerting through it would go silent
exactly when it matters. `report_failure_activity` posts straight to Slack
(bot token or incoming webhook).

Auto RCA runs on Rose: Slack delivers the bot's top-level card to the backend's
`/api/webhooks/slack/auto-rca`, which creates one Rose RCA root agent per error
signature window. A Temporal retry after a lost activity completion can post a
duplicate card; the webhook folds it into the same incident (same signature),
so it never starts a second RCA. The in-memory throttle remains best-effort
noise control, never a correctness boundary. The activity NEVER raises.
"""

import json
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
_in_flight: set[str] = set()
_lock = threading.Lock()


def _fingerprint(source: str, message: str) -> str:
    n = message.lower()
    n = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<uuid>", n)
    n = re.sub(r"0x[0-9a-f]+", "<hex>", n)
    n = re.sub(r"\d+", "<n>", n)
    n = re.sub(r"\s+", " ", n).strip()[:200]
    return f"{source}:{n}"


def _acquire_alert_slot(key: str, now: float) -> bool:
    with _lock:
        prev = _last_sent.get(key)
        if prev is not None and now - prev < _THROTTLE_WINDOW_S:
            return False
        if key in _in_flight:
            return False

        _in_flight.add(key)
        stale = [candidate for candidate, sent_at in _last_sent.items() if now - sent_at >= _THROTTLE_WINDOW_S]
        for candidate in stale:
            _last_sent.pop(candidate, None)
        return True


def _finish_alert_slot(key: str, delivered: bool, now: float) -> None:
    with _lock:
        _in_flight.discard(key)
        if not delivered:
            return

        # Refresh insertion order so overflow eviction removes the oldest send.
        _last_sent.pop(key, None)
        _last_sent[key] = now
        while len(_last_sent) > _MAX_THROTTLE_ENTRIES:
            _last_sent.pop(next(iter(_last_sent)))


def _slack_payload(
    source: str,
    message: str,
    agent_id: Optional[str],
    context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    label = _SOURCE_LABEL.get(source, "🔴 Failure")
    fields = [{"type": "mrkdwn", "text": f"*Source:*\n{source}"}]
    if agent_id:
        fields.append({"type": "mrkdwn", "text": f"*Agent:*\n`{agent_id}`"})

    blocks: list[Dict[str, Any]] = [
        {"type": "header", "text": {"type": "plain_text", "text": label}},
        {"type": "section", "text": {"type": "mrkdwn", "text": "```" + message[:600] + "```"}},
        {"type": "section", "fields": fields},
    ]
    if context:
        serialized = json.dumps(context, default=str).replace("```", "''' ")[:500]
        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"*Context:*\n```{serialized}```"},
            }
        )
    if agent_id:
        fe_link = f"{_FE_BASE}/?agent-id={agent_id}"
        diag = f"cd agents && python benchmarks/agent_logs.py {agent_id} --url {_PROD_BACKEND} --tree --diagnostics"
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": f"<{fe_link}|Open agent in the app>"}})
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": f"`{diag}`"}]})

    return {"text": f"{label}: {message[:140]}", "blocks": blocks}


async def _post_slack_bot(token: str, channel: str, payload: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """Post the initial card via chat.postMessage and return {ts, channel}.

    A bot-token post (unlike an incoming webhook) yields an editable message
    handle; its thread later receives the RCA agent link and outcome.
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


@activity.defn
async def report_failure_activity(
    agent_id: Optional[str],
    source: str,
    message: str,
    context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Emit an agent failure to #errors (the auto-RCA webhook reads the card).

    Best-effort — always returns, never raises. Deduped by the in-memory throttle.
    """
    # Alerts are agent-scoped; the auto-RCA webhook collapses one incident
    # signature into one RCA agent.
    signature = _fingerprint(source, message)
    key = f"alert:{agent_id or '-'}:{signature}"
    acquired = False
    delivered = False
    try:
        acquired = _acquire_alert_slot(key, time.time())
        if not acquired:
            return {"alerted": False, "throttled": True}

        bot_token = os.environ.get("SLACK_BOT_TOKEN")
        channel_id = os.environ.get("SLACK_ERROR_CHANNEL_ID")
        webhook = os.environ.get("SLACK_ERROR_WEBHOOK_URL")

        payload = _slack_payload(source, message, agent_id, context)

        # Prefer the bot token: its top-level card is what the auto-RCA webhook
        # turns into a Rose RCA agent. Fall back to an incoming webhook.
        alerted = False
        if bot_token and channel_id:
            posted = await _post_slack_bot(bot_token, channel_id, payload)
            if posted:
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

        delivered = alerted
        return {"alerted": alerted}
    except Exception as e:  # never fail the agent because alerting failed
        activity.logger.warning(f"report_failure_activity non-fatal: {e}")
        return {"alerted": False, "error": str(e)}
    finally:
        if acquired:
            # Failed transports remain eligible for the next occurrence to retry.
            _finish_alert_slot(key, delivered, time.time())
