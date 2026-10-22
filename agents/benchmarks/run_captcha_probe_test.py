"""Offline tests for the CAPTCHA probe catalog and verdict logic (no stack, no LLM)."""

import json

from benchmarks.run_captcha_probe import (
    collect_antibot_events,
    decide_verdict,
    load_probes,
    summarize_events,
    tree_agent_ids,
)

ROOT = "84a6cb53-e3a0-43f6-83cd-a8237fa57758"
BROWSER = "5ef56c1d-e27a-49d5-873a-dfb3dce1e982"
OTHER = "22858ea0-b08f-4fa9-9bd5-da6e39359027"
USER = "1f85ff25-6e29-4c1b-8739-f917bd101a30"


def _line(event: str, **fields) -> str:
    return "2026-10-22 04:10:45 [info] " + json.dumps({"event": event, **fields})


STUCK_LOG = [
    _line("Challenge LLM classifier result", challenged=True, reason="Google /sorry", agent_id=BROWSER),
    _line(
        "antibot.episode",
        agent_id=BROWSER,
        host="www.google.com",
        cleared=False,
        recovery_invoked=True,
        recovery_outcome="failed: Browser storage capture timed out after 15s before challenge recovery.",
    ),
    _line("antibot.stuck", agent_id=BROWSER, host="www.google.com", final_url_host="www.google.com"),
    # Another agent on the same worker, and a user-scoped line: neither belongs to this run.
    _line("antibot.stuck", agent_id=OTHER, host="tinypng.com"),
    _line("antibot.episode", user_id=USER, host="example.com"),
    _line("Something unrelated", agent_id=BROWSER),
]

CLEARED_LOG = [
    _line("Challenge LLM classifier result", challenged=True, reason="DataDome", agent_id=BROWSER),
    _line("antibot.episode", agent_id=BROWSER, host="www.target.com", cleared=True, recovery_outcome="cleared_after_patience"),
]


def _summary(lines):
    return summarize_events(collect_antibot_events(lines, tree_agent_ids(ROOT, [{"child": BROWSER, "user": USER}], [USER])))


def test_log_collection_is_scoped_to_the_agent_tree():
    events = collect_antibot_events(STUCK_LOG, tree_agent_ids(ROOT, [{"child": BROWSER, "user": USER}], [USER]))
    assert [event["_event"] for event in events] == [
        "Challenge LLM classifier result",
        "antibot.episode",
        "antibot.stuck",
    ]
    summary = summarize_events(events)
    assert summary == {
        "episodes": 1,
        "stuck": 1,
        "recovery_failed": 1,
        "classifier_challenged": 1,
        "cleared": 0,
        "last_stuck_host": "www.google.com",
    }


def test_unresolved_challenge_is_failed_even_when_judge_hedges():
    summary = _summary(STUCK_LOG)
    hedged = {"verdict": "INCONCLUSIVE", "reason": "agent stopped"}
    assert decide_verdict(hedged, summary, "agent COMPLETED")["verdict"] == "FAILED_CAPTCHA"
    unsupported_pass = {"verdict": "PASSED_CAPTCHA", "reason": "agent said done", "evidence_seen": ""}
    assert decide_verdict(unsupported_pass, summary, "agent COMPLETED")["verdict"] == "FAILED_CAPTCHA"


def test_failed_recovery_without_evidence_is_failed():
    summary = summarize_events(collect_antibot_events(STUCK_LOG[:2], [BROWSER]))
    assert summary["stuck"] == 0 and summary["recovery_failed"] == 1
    decided = decide_verdict({"verdict": "INCONCLUSIVE", "reason": ""}, summary, "cap reached")
    assert decided["verdict"] == "FAILED_CAPTCHA"


def test_cleared_wall_with_post_wall_evidence_passes():
    judged = {"verdict": "PASSED_CAPTCHA", "reason": "price visible", "evidence_seen": "iPad Air M3 $599.99"}
    assert decide_verdict(judged, _summary(CLEARED_LOG), "agent COMPLETED") == {
        "verdict": "PASSED_CAPTCHA",
        "reason": "price visible",
    }


def test_no_wall_and_evidence_reached_passes():
    judged = {"verdict": "passed_captcha", "reason": "results listed", "evidence_seen": "organic results"}
    assert decide_verdict(judged, _summary([]), "agent COMPLETED")["verdict"] == "PASSED_CAPTCHA"


def test_judge_failed_verdict_is_kept():
    judged = {"verdict": "FAILED_CAPTCHA", "reason": "Access Denied page at the end"}
    assert decide_verdict(judged, _summary([]), "agent COMPLETED")["verdict"] == "FAILED_CAPTCHA"


def test_non_captcha_stop_is_inconclusive_with_its_reason():
    judged = {"verdict": "INCONCLUSIVE", "reason": "agent asked which theater to use before navigating"}
    decided = decide_verdict(judged, _summary([]), "pending question/approval (not approved): Which theater?")
    assert decided == {"verdict": "INCONCLUSIVE", "reason": "agent asked which theater to use before navigating"}
    no_reason = decide_verdict({"verdict": "INCONCLUSIVE"}, _summary([]), "cap reached")
    assert no_reason == {"verdict": "INCONCLUSIVE", "reason": "cap reached"}


def test_invalid_judge_reply_is_inconclusive_not_a_pass():
    decided = decide_verdict({"verdict": "maybe"}, _summary([]), "agent FAILED")
    assert decided["verdict"] == "INCONCLUSIVE" and "agent FAILED" in decided["reason"]


def test_probe_catalog_covers_every_production_site():
    probes = load_probes()
    assert len(probes) == 39
    held = sorted(name for name, probe in probes.items() if probe["hold"])
    assert held == ["nvidia-geforce-now-account", "uber-login"]
    assert {"kokkari-menu", "foreign-cinema-menu"} <= set(probes)
    for name, probe in probes.items():
        assert 'spawn_agent with type="browser"' in probe["goal"], name
        assert "Do not ask me any questions" in probe["goal"], name
        assert probe["post_wall_evidence"] and probe["where_captcha_hit"], name
        assert ("{frontend_url}" in probe["goal"]) == (name == "stripe-test-payment"), name
        if probe["hold"]:
            assert probe.get("hold_reason"), name
