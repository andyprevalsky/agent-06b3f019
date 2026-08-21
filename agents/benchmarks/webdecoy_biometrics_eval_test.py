"""Regression tests for browser-biometrics-webdecoy outcome evaluation.

Reproduces the 2026-08-21 smoke failure where a grounded structured score of
0.00 was ignored (schema key fcaptcha_risk_score) and a numbered-list ordinal
"(3) Risk score" was scraped as visible score 3.000.
"""

from __future__ import annotations

from benchmarks import run_benchmark as rb


def _task_complete_message(
    *,
    structured: dict | None,
    body: str,
) -> dict:
    metadata = {
        "toolName": "spawn_browser_agent",
        "toolStatus": "FINISHED",
        "action_type": "task_complete",
    }
    if structured is not None:
        metadata["structured_response"] = structured
    return {"role": "TOOL", "message": body, "metadata": metadata}


def test_webdecoy_structured_score_reads_fcaptcha_risk_score_key():
    data = {
        "messages": [
            _task_complete_message(
                structured={"fcaptcha_risk_score": "0.00", "checkbox_mode_passed": True},
                body="visited https://webdecoy.com/product/fcaptcha-demo/",
            )
        ]
    }
    assert rb._webdecoy_structured_score(data) == 0.0


def test_webdecoy_visible_score_ignores_numbered_list_ordinal():
    # Exact false-positive shape from agent aa21e9a7 (smoke 20260821_055051).
    text = (
        "(2) Invisible form submitted. (3) Risk score: the page displays '0.00' "
        "next to the label 'Risk Score (lower = human)' — fcaptcha_risk_score = '0.00'."
    ).lower()
    scores = rb._webdecoy_visible_risk_scores(text)
    assert 3.0 not in scores
    assert scores[-1] == 0.0


def test_webdecoy_eval_prefers_structured_fcaptcha_over_list_ordinal_noise():
    body = (
        "Visited https://webdecoy.com/product/fcaptcha-demo/. Clicked checkbox. "
        "Submitted invisible mode form with benchmark-human@example.com. "
        "(3) Risk score: the page displays '0.00' next to Risk Score (lower = human)."
    )
    data = {
        "messages": [
            _task_complete_message(
                structured={
                    "fcaptcha_risk_score": "0.00",
                    "checkbox_mode_passed": True,
                    "invisible_form_submitted": True,
                },
                body=body,
            )
        ]
    }
    # Buggy behavior: visible scrape of "3) Risk score" → fail at 3.000.
    passed, reason = rb._evaluate_webdecoy_biometrics_result(data)
    assert passed is True, reason
    assert reason is None


def test_webdecoy_eval_visible_fallback_still_reads_decimal_score():
    body = (
        "Visited https://webdecoy.com/product/fcaptcha-demo/. Clicked checkbox. "
        "Submitted invisible mode form with benchmark-human@example.com. "
        "Risk Score (lower = human): 0.09"
    )
    data = {"messages": [{"role": "TOOL", "message": body, "metadata": {}}]}
    passed, reason = rb._evaluate_webdecoy_biometrics_result(data)
    assert passed is True, reason
