"""Warm-connection metrics computed from a native WMH world, never hand-written.

usage: python -m benchmarks.wmh_warm_metrics --initial-state STATE.json --retirement RECEIPT.json [--out OUT.json]

Inputs are the run's ``--wmh-initial-state-file`` (its static network) and the
native retirement receipt (``<wmh root>/native-retirements/<session>.json``:
the committed history and final state). Two populations are counted separately:

* historical warm leads: network contacts whose derived warmth is strong/warm
  (``wmh_context_insertion.warmth_tier``), split by investor-like email domain,
  and how many of them a committed outreach action addressed;
* new warm leads: counterparties whose sampled response events (reply,
  meeting proposal, introduction, held meeting, commitment) were delivered in the
  run and who were not historical warm contacts, and how many were then
  addressed again.

Contacts are matched by exact email address or phone digits found in committed
action arguments and event fields: identity matching, not content classification.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from benchmarks.wmh_context_insertion import INVESTOR_DOMAIN_TOKENS, warmth_tier

SCHEMA = "rose.wmh_warm_metrics.v1"
# Committed actions that can address a contact: direct messages, browser sessions (webmail,
# intake forms) and calls. Research categories only mention contacts.
OUTREACH_CATEGORIES = frozenset({"message", "browser", "vapi"})
WARM_RESPONSE_KINDS = frozenset({"reply", "meeting_proposal", "introduction", "meeting_held", "commitment"})
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PHONE = re.compile(r"\+?\d[\d\s().-]{8,}\d")


def _phone(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    return digits[-10:] if len(digits) >= 10 else ""


def identities(value: Any) -> set[str]:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    found = {f"email:{m.lower()}" for m in _EMAIL.findall(text)}
    found |= {f"phone:{p}" for p in map(_phone, _PHONE.findall(text)) if p}
    return found


def network_contacts(state: dict) -> list[dict]:
    network = (state.get("structured") or {}).get("network") or {}
    packet = network.get("static_full_network") if isinstance(network, dict) else None
    if not isinstance(packet, dict) or not isinstance(packet.get("row_columns"), list):
        return []
    shared = packet.get("shared_fields") if isinstance(packet.get("shared_fields"), dict) else {}
    contacts = []
    for values in packet.get("rows") or []:
        row = {**shared, **dict(zip(packet["row_columns"], values))}
        addresses = [a for a in [*(row.get("emailAddresses") or []), row.get("email")] if isinstance(a, str) and "@" in a]
        keys = {f"email:{a.lower()}" for a in addresses}
        if isinstance(row.get("phoneNumber"), str) and _phone(row["phoneNumber"]):
            keys.add(f"phone:{_phone(row['phoneNumber'])}")
        domains = {a.rsplit("@", 1)[-1].lower() for a in addresses}
        contacts.append(
            {
                "id": row.get("id"),
                "keys": keys,
                "tier": warmth_tier(row.get("messagesExchanged"), row.get("communicationFrequency")),
                "investor_like": any(t in d for d in domains for t in INVESTOR_DOMAIN_TOKENS),
            }
        )
    return contacts


def _outreach_steps(history: list, categories=OUTREACH_CATEGORIES) -> list[tuple[int, set[str]]]:
    steps = []
    for step in history:
        action = step.get("action") or {}
        arguments = action.get("arguments") or {}
        if arguments.get("category") in categories:
            steps.append((arguments.get("timestamp_ms") or 0, identities(arguments.get("arguments"))))
    return steps


def warm_metrics(initial_state: dict, retirement: dict, *, outreach_categories=OUTREACH_CATEGORIES) -> dict:
    contacts = network_contacts(initial_state)
    warm = [c for c in contacts if c["tier"] in {"strong", "warm"}]
    warm_keys = set().union(*(c["keys"] for c in warm)) if warm else set()
    outreach = _outreach_steps(retirement.get("history") or [], frozenset(outreach_categories))
    addressed = set().union(*(keys for _, keys in outreach)) if outreach else set()
    followed = [c for c in warm if c["keys"] & addressed]
    events = ((retirement.get("state") or {}).get("structured") or {}).get("scheduled_events") or []
    new_leads: dict[str, int] = {}
    for event in events:
        if not isinstance(event, dict) or event.get("kind") not in WARM_RESPONSE_KINDS:
            continue
        if "delivered_at_ms" not in event:
            continue
        keys = identities(event.get("from") or "") | identities(event.get("details") or {})
        if not keys or keys & warm_keys:
            continue
        lead = sorted(keys)[0]
        new_leads[lead] = min(new_leads.get(lead, event["delivered_at_ms"]), event["delivered_at_ms"])
    new_followed = sum(
        1 for lead, delivered in new_leads.items() if any(at > delivered and lead in keys for at, keys in outreach)
    )
    return {
        "schema": SCHEMA,
        "outreach_categories": sorted(outreach_categories),
        "committed_steps": len(retirement.get("history") or []),
        "outreach_steps": len(outreach),
        "historical": {
            "network_contacts": len(contacts),
            "warm_leads": len(warm),
            "warm_investor_like_leads": sum(c["investor_like"] for c in warm),
            "warm_leads_followed_up": len(followed),
            "warm_investor_like_leads_followed_up": sum(c["investor_like"] for c in followed),
        },
        "new": {
            "warm_leads": len(new_leads),
            "warm_leads_followed_up": new_followed,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--initial-state", required=True, type=Path)
    parser.add_argument("--retirement", required=True, type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--outreach-category", action="append", help="Override the outreach action categories")
    args = parser.parse_args(argv)
    metrics = warm_metrics(
        json.loads(args.initial_state.read_text(encoding="utf-8")),
        json.loads(args.retirement.read_text(encoding="utf-8")),
        outreach_categories=frozenset(args.outreach_category or OUTREACH_CATEGORIES),
    )
    text = json.dumps(metrics, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
