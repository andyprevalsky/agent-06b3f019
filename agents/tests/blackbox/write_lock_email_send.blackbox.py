"""Blackbox tests for the email_send write-lock classification corpus.

Owns tests/fixtures/write_lock_email_send_corpus.json:
  - the Target prod incident (agent f1ef359f): ``Didn't get a code?`` link whose
    camelCase id ``showResendMessageLink`` tripped email_send
  - 50 false-positive risks (must NOT lock)
  - 50 false-negative risks (MUST lock)

Also asserts the incident through the full click-gate evaluator, and that
production write_lock.py does not memorize corpus labels.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

from _test_utils import BlackboxResult, teardown_mock

FIXTURE = (
    Path(__file__).resolve().parent.parent / "fixtures" / "write_lock_email_send_corpus.json"
)
WRITE_LOCK_SRC = (
    Path(__file__).resolve().parent.parent.parent / "browser_tools" / "write_lock.py"
)


def _load_corpus() -> dict:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert len(data["false_positive_risks"]) == 50, len(data["false_positive_risks"])
    assert len(data["false_negative_risks"]) == 50, len(data["false_negative_risks"])
    labels = [e["label"] for e in data["false_positive_risks"] + data["false_negative_risks"]]
    assert len(set(labels)) == len(labels), "corpus labels must be unique"
    return data


def test_prod_incident_target_resend_link_does_not_lock():
    """Agent f1ef359f: Target's ``Didn't get a code?`` link must not lock."""
    from browser_tools.write_lock import is_email_send_button

    incident = _load_corpus()["incident"]
    assert is_email_send_button(incident["label"], incident["url"]) is False


def test_prod_incident_target_resend_link_passes_click_gate():
    """The exact incident signal must clear every click write-lock check."""
    from domains.spawn_browser_agent_v3.service_actions import (
        _evaluate_element_text_write_lock,
    )

    incident = _load_corpus()["incident"]
    result = _evaluate_element_text_write_lock(
        element_text=incident["label"],
        write_lock_approvals=None,
        current_url=incident["url"],
        system_name="Rose",
        action_label="click",
        element_text_for_question=incident["label"][:100],
    )
    assert result is None, result


def test_corpus_false_positive_risks_do_not_lock():
    """Resends, code/link requests to the account, and send-me opt-ins stay open."""
    from browser_tools.write_lock import is_email_send_button

    hits = [
        e["label"]
        for e in _load_corpus()["false_positive_risks"]
        if is_email_send_button(e["label"], e.get("url", ""))
    ]
    assert hits == [], f"FP-risk labels locked ({len(hits)}): {hits}"


def test_corpus_false_negative_risks_lock():
    """Real outbound sends, including id-only icon buttons, stay locked."""
    from browser_tools.write_lock import is_email_send_button

    misses = [
        e["label"]
        for e in _load_corpus()["false_negative_risks"]
        if not is_email_send_button(e["label"], e.get("url", ""))
    ]
    assert misses == [], f"FN-risk labels not locked ({len(misses)}): {misses}"


def test_generative_resend_identifiers_do_not_lock():
    """Held-out resend ids in every casing style must not lock.

    Built at runtime so a matcher that memorizes the fixture cannot pass.
    """
    from browser_tools.write_lock import is_email_send_button

    heads = ["show", "auth", "otp", "login", "didNotGet", "verify"]
    tails = ["Code", "Email", "Sms", "Message", "Link", "Otp"]
    failures = []
    for head in heads:
        for tail in tails:
            camel = f"{head}Resend{tail}"
            kebab = re.sub(r"(?<=[a-z])(?=[A-Z])", "-", camel).lower()
            snake = kebab.replace("-", "_").upper()
            for ident in (camel, kebab, snake):
                if is_email_send_button(f"Didn't get it?\n{ident}"):
                    failures.append(ident)
    assert failures == [], f"generative resend FP ({len(failures)}): {failures[:20]}"


def test_generative_send_identifiers_still_lock():
    """Held-out id-only send controls must lock in every casing style."""
    from browser_tools.write_lock import is_email_send_button

    heads = ["compose", "chat", "reply", "inbox", "thread", "dm"]
    tails = ["Btn", "Button", "Action", "Cta", "Icon"]
    failures = []
    for head in heads:
        for tail in tails:
            camel = f"{head}Send{tail}"
            kebab = re.sub(r"(?<=[a-z])(?=[A-Z])", "-", camel).lower()
            snake = kebab.replace("-", "_").upper()
            for ident in (camel, kebab, snake, f"send{tail}"):
                if not is_email_send_button(ident):
                    failures.append(ident)
    assert failures == [], f"generative send FN ({len(failures)}): {failures[:20]}"


def test_anti_reward_hack_corpus_not_embedded_in_production():
    """write_lock.py must not import the fixture or paste corpus labels as code."""
    raw = WRITE_LOCK_SRC.read_text(encoding="utf-8")
    assert "write_lock_email_send_corpus" not in raw
    assert "tests/fixtures" not in raw

    no_docs = re.sub(r'"""[\s\S]*?"""', "", raw)
    code_only = "\n".join(line.split("#", 1)[0] for line in no_docs.splitlines()).lower()
    corpus = _load_corpus()
    embedded = []
    for e in corpus["false_positive_risks"] + corpus["false_negative_risks"]:
        probe = e["label"].split("\n", 1)[0].strip().lower()
        if len(probe) >= 14 and probe in code_only:
            embedded.append(probe)
    assert "showresendmessagelink" not in code_only
    assert embedded == [], f"corpus labels embedded in write_lock.py: {embedded[:15]}"


async def run_all_tests():
    print("write-lock-email-send blackbox tests:")
    r = BlackboxResult()
    r.record(
        "prod_incident_target_resend_link_does_not_lock",
        test_prod_incident_target_resend_link_does_not_lock,
    )
    r.record(
        "prod_incident_target_resend_link_passes_click_gate",
        test_prod_incident_target_resend_link_passes_click_gate,
    )
    r.record("corpus_false_positive_risks_do_not_lock", test_corpus_false_positive_risks_do_not_lock)
    r.record("corpus_false_negative_risks_lock", test_corpus_false_negative_risks_lock)
    r.record("generative_resend_identifiers_do_not_lock", test_generative_resend_identifiers_do_not_lock)
    r.record("generative_send_identifiers_still_lock", test_generative_send_identifiers_still_lock)
    r.record(
        "anti_reward_hack_corpus_not_embedded_in_production",
        test_anti_reward_hack_corpus_not_embedded_in_production,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
