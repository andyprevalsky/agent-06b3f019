"""Blackbox tests for purchase write-lock classification corpus.

Owns the 300-case fixture at tests/fixtures/write_lock_purchase_corpus.json:
  - 100 true positives (final charge commits)
  - 100 issues (50 FN-risk expected True, 50 FP-risk expected False)
  - 100 true negatives (nav / chrome / non-commit)

Also asserts anti-reward-hacking: production write_lock.py must not embed the
corpus labels as an allow/deny list, and generative fulfillment insertions that
are NOT listed in the corpus must still classify correctly.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

from _test_utils import BlackboxResult, teardown_mock

FIXTURE = (
    Path(__file__).resolve().parent.parent / "fixtures" / "write_lock_purchase_corpus.json"
)
WRITE_LOCK_SRC = (
    Path(__file__).resolve().parent.parent.parent / "browser_tools" / "write_lock.py"
)


def _load_corpus() -> dict:
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert len(data["true_positives"]) == 100, len(data["true_positives"])
    assert len(data["issues"]) == 100, len(data["issues"])
    assert len(data["true_negatives"]) == 100, len(data["true_negatives"])
    fn = [e for e in data["issues"] if e["expected"] is True]
    fp = [e for e in data["issues"] if e["expected"] is False]
    assert len(fn) == 50 and len(fp) == 50
    return data


def test_corpus_true_positives_lock():
    """Every corpus true-positive label must trip the purchase write lock."""
    from browser_tools.write_lock import is_purchase_button

    corpus = _load_corpus()
    misses = [
        e["label"]
        for e in corpus["true_positives"]
        if not is_purchase_button(e["label"])
    ]
    assert misses == [], f"TP misses ({len(misses)}): {misses[:20]}"


def test_corpus_issues_match_expected():
    """FN-risk labels lock; FP-risk labels do not."""
    from browser_tools.write_lock import is_purchase_button

    corpus = _load_corpus()
    wrong = []
    for e in corpus["issues"]:
        got = is_purchase_button(e["label"])
        if got is not e["expected"]:
            wrong.append(
                {
                    "label": e["label"],
                    "expected": e["expected"],
                    "got": got,
                    "kind": e["issue_kind"],
                    "why": e["why"],
                }
            )
    assert wrong == [], f"issue mismatches ({len(wrong)}): {wrong[:20]}"


def test_corpus_true_negatives_do_not_lock():
    """Non-commit chrome must not trip the purchase write lock."""
    from browser_tools.write_lock import is_purchase_button

    corpus = _load_corpus()
    hits = [
        e["label"]
        for e in corpus["true_negatives"]
        if is_purchase_button(e["label"])
    ]
    assert hits == [], f"TN false positives ({len(hits)}): {hits[:20]}"


def test_prod_incident_place_pickup_order_locks():
    """DoorDash agent 3a7c0315 exact label must lock."""
    from browser_tools.write_lock import is_purchase_button

    assert is_purchase_button("Place Pickup Order\n$20.31")
    assert is_purchase_button("Place Pickup Order")


def test_anti_reward_hack_corpus_not_embedded_in_production():
    """Production matcher must not copy corpus TP/FN labels into an allow list.

    Comments/docstrings may mention incident labels (they document the bug).
    Reward hacking means pasting those labels into executable string literals
    beyond the small PURCHASE_BUTTON_PHRASES / exclusion sets. TN/FP corpus
    rows are ignored here — they legitimately overlap submit-exclusion chrome.
    """
    from browser_tools import write_lock as wl

    raw = WRITE_LOCK_SRC.read_text(encoding="utf-8")
    # Drop block docstrings and # comments so RCA narrative is not scored.
    no_docs = re.sub(r'"""[\s\S]*?"""', "", raw)
    no_docs = re.sub(r"'''[\s\S]*?'''", "", no_docs)
    code_only = "\n".join(
        line.split("#", 1)[0] for line in no_docs.splitlines()
    ).lower()

    allowed_norms = {
        wl.normalize_write_lock_text(p) for p in wl.PURCHASE_BUTTON_PHRASES
    }
    allowed_norms |= {
        wl.normalize_write_lock_text(p) for p in wl.PURCHASE_CONSENT_PROSE_PATTERNS
    }
    allowed_norms |= {
        wl.normalize_write_lock_text(p)
        for p in wl.PURCHASE_INFORMATIONAL_EXCLUSION_PATTERNS
    }

    corpus = _load_corpus()
    candidates = [e["label"] for e in corpus["true_positives"]]
    candidates += [
        e["label"] for e in corpus["issues"] if e["issue_kind"] == "false_negative_risk"
    ]

    embedded = []
    seen = set()
    for label in candidates:
        probe = label.split("\n", 1)[0].strip()
        key = probe.lower()
        if key in seen:
            continue
        seen.add(key)
        if len(probe) < 12:
            continue
        if wl.normalize_write_lock_text(probe) in allowed_norms:
            continue
        if key in code_only:
            embedded.append(probe)

    assert embedded == [], (
        "Corpus TP/FN labels embedded as code in write_lock.py (reward hack): "
        f"{embedded[:15]}"
    )


def test_anti_reward_hack_no_corpus_import_in_production():
    """write_lock.py must not import the fixture JSON or this test module."""
    src = WRITE_LOCK_SRC.read_text(encoding="utf-8")
    assert "write_lock_purchase_corpus" not in src
    assert "write_lock_purchase.blackbox" not in src
    assert "tests/fixtures" not in src


def test_generative_fulfillment_insertion_still_locks():
    """Held-out fulfillment insertions (not relying on the JSON list) must lock.

    Builds Place/Complete/Confirm/Submit + <mod> + Order/Purchase at runtime so
    a matcher that only memorizes the fixture cannot pass by listing those
    strings in production code.
    """
    from browser_tools.write_lock import is_purchase_button

    # Mods deliberately include spellings not all present as corpus rows alone.
    mods = [
        "Pickup",
        "Delivery",
        "Shipping",
        "Takeout",
        "Take-Out",
        "To-Go",
        "Curbside",
        "Same-Day",
        "Express",
        "Priority",
        "ASAP",
        "Drive-Thru",
    ]
    frames = [
        ("Place", "Order"),
        ("Place Your", "Order"),
        ("Complete", "Order"),
        ("Complete", "Purchase"),
        ("Confirm", "Order"),
        ("Submit", "Order"),
        ("Submit Your", "Order"),
    ]
    failures = []
    for left, right in frames:
        for mod in mods:
            label = f"{left} {mod} {right}"
            if not is_purchase_button(label):
                failures.append(label)
            priced = f"{label}\n$17.42"
            if not is_purchase_button(priced):
                failures.append(priced)
    assert failures == [], f"generative FN ({len(failures)}): {failures[:20]}"


def test_generative_consent_and_bnpl_still_excluded():
    """Held-out consent/BNPL wrappers must stay false (not memorized exclusions)."""
    from browser_tools.write_lock import is_purchase_button

    held_out_negatives = [
        'By clicking "Buy Now" you agree to the Terms of Purchase and Privacy Policy',
        "By selecting Place Order, you agree to our terms of service",
        "Buy Now Pay Later with Affirm",
        "buy now, pay later — soft credit check",
        "Pay later",
        "Proceed to checkout",
        "Add to Cart — $20.31",
        "Return to your orders",
        "Track your pickup order",
        "Cancel pickup order",
        "buynow-checkout-email",
    ]
    hits = [s for s in held_out_negatives if is_purchase_button(s)]
    assert hits == [], f"held-out FP ({len(hits)}): {hits}"


def test_place_order_pay_later_still_locks():
    """Charge commits that mention pay-later must not be excluded by BNPL chrome.

    CodeRabbit on PR #1197: bare `paylater` exclusion would skip the write lock
    for labels like `Place order — pay later` (contains both placeorder + paylater).
    """
    from browser_tools.write_lock import is_purchase_button

    assert is_purchase_button("Place order — pay later")
    assert is_purchase_button("Place Order Pay Later")
    assert is_purchase_button("Complete purchase — pay later with Klarna")
    # Informational BNPL chrome still excluded
    assert not is_purchase_button("Buy now, pay later")
    assert not is_purchase_button("Buy Now Pay Later with Affirm")
    assert not is_purchase_button("Learn about buy now pay later")


def test_method_is_fulfillment_collapse_not_phrase_dump():
    """Matcher must expose fulfillment collapse — not only a giant phrase list.

    Inspects production source for the transparent-fulfillment mechanism so a
    future change cannot replace the general method with a pasted corpus dump
    and still look green on the fixture alone.
    """
    src = WRITE_LOCK_SRC.read_text(encoding="utf-8")
    assert "_purchase_signal_match_forms" in src
    assert "_PURCHASE_FULFILLMENT_TRANSPARENT_RE" in src
    assert "pick" in src and "delivery" in src
    # Phrase list must stay small relative to the 300-case corpus.
    from browser_tools.write_lock import PURCHASE_BUTTON_PHRASES

    assert len(PURCHASE_BUTTON_PHRASES) < 40, (
        f"PURCHASE_BUTTON_PHRASES grew to {len(PURCHASE_BUTTON_PHRASES)}; "
        "prefer fulfillment collapse over dumping corpus labels"
    )


def test_existing_eventim_and_fandango_exclusions_still_hold():
    """Prior RCA exclusions must not regress when expanding purchase coverage."""
    from browser_tools.write_lock import is_purchase_button

    terms = (
        'By clicking "Buy Now," you agree to our\n'
        "Terms of Purchase\n"
        "and acknowledge our privacy practices as described in our\n"
        "Privacy Policy."
    )
    assert not is_purchase_button(terms)
    assert not is_purchase_button("buynow-email-si")
    assert is_purchase_button("Buy Now")
    assert is_purchase_button("Place Order")
    assert is_purchase_button("Terms of Service\nBuy Now")


async def run_all_tests():
    print("write-lock-purchase blackbox tests:")
    r = BlackboxResult()
    r.record("corpus_true_positives_lock", test_corpus_true_positives_lock)
    r.record("corpus_issues_match_expected", test_corpus_issues_match_expected)
    r.record("corpus_true_negatives_do_not_lock", test_corpus_true_negatives_do_not_lock)
    r.record("prod_incident_place_pickup_order_locks", test_prod_incident_place_pickup_order_locks)
    r.record(
        "anti_reward_hack_corpus_not_embedded_in_production",
        test_anti_reward_hack_corpus_not_embedded_in_production,
    )
    r.record(
        "anti_reward_hack_no_corpus_import_in_production",
        test_anti_reward_hack_no_corpus_import_in_production,
    )
    r.record(
        "generative_fulfillment_insertion_still_locks",
        test_generative_fulfillment_insertion_still_locks,
    )
    r.record(
        "generative_consent_and_bnpl_still_excluded",
        test_generative_consent_and_bnpl_still_excluded,
    )
    r.record(
        "place_order_pay_later_still_locks",
        test_place_order_pay_later_still_locks,
    )
    r.record(
        "method_is_fulfillment_collapse_not_phrase_dump",
        test_method_is_fulfillment_collapse_not_phrase_dump,
    )
    r.record(
        "existing_eventim_and_fandango_exclusions_still_hold",
        test_existing_eventim_and_fandango_exclusions_still_hold,
    )
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
