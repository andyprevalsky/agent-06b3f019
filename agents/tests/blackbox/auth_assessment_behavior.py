"""Offline integrated controls for explicit per-recipient escalation decisions."""
from copy import deepcopy
from otp_retry_behavior import _offline_activity_edges

URL = "https://shop.example/login/verify"
INVENTORY = {"realm": "shop.example", "minted": {"id": "owned", "email": "owned@example.test", "phone": "+15550000002"}}

def assessment(*, phone="not_applicable", email="not_applicable", blocker="automated_options_exhausted", reason="The page rejected this recipient; no other applicable options remain."):
    return {"auth_realm": "shop.example", "page_url": URL, "blocker": blocker,
            "reason": reason, "recipient_options": [
                {"method": "email_otp", "recipient": "owned@example.test", "status": email, "evidence": "This form accepts phone numbers only."},
                {"method": "sms_otp", "recipient": "+15550000002", "status": phone, "evidence": "Observed recipient-specific result, not a site membership assertion.", "evidence_steps": [3] if phone == "exhausted" else []},
            ]}

def handoff(a):
    return {"action": "request_user_assistance_for_authentication", "thinking": "Assess the current options", "params": {"auth_assessment": a}}

async def assert_auth_assessment_controls(owning_fixture):
    observations = []
    # The old real activity pauses immediately at the first declaration, even
    # though that same declaration says an applicable supplied operation remains.
    before_other_recipient = assessment(phone="remaining")
    before_other_recipient["attempted_recipient_options"] = [{"method": "sms_otp", "recipient": "+15550000001", "status": "exhausted", "evidence": "The submitted personal recipient was rejected", "evidence_steps": [1,2]}]
    final = assessment(phone="exhausted");final["recipient_options"][1]["evidence_steps"] = [5]
    final["attempted_recipient_options"] = deepcopy(before_other_recipient["attempted_recipient_options"])
    r = {"inventory": deepcopy(INVENTORY), "actions": [
        {"action": "input_text", "index": 7, "params": {"text": "+15550000001"}},
        {"action": "click", "index": 8, "params": {}},
        handoff(before_other_recipient),
        {"action": "input_text", "index": 7, "params": {"text": "+15550000002"}, "thinking": "Use the supplied phone on the current form"},
        {"action": "click", "index": 8, "params": {}, "thinking": "Submit the supplied recipient"},
        handoff(final),
    ]}
    with _offline_activity_edges():
        await owning_fixture("empty", auth_review=r)
    assert [x["params"]["text"] for x in r["executed"] if x["action"] == "input_text"] == ["+15550000001", "+15550000002"]
    assert "action_step" in str(r["contexts"][5]["turn_messages"])
    assert "authentication_options_remaining" in str(r["contexts"][3]["turn_messages"])
    assert r["result"]["auth_assessment"] == final
    observations.append({"case": "remaining_sms_to_native_input", "decisions": len(r["contexts"]), "inputs": 2})
    # Named account exclusion / unknown reader are deliberate model judgements,
    # never automatic ownership=>registration or automatic account retargeting.
    for a in [
        assessment(phone="not_applicable", reason="The actual goal names a different account; these recipients cannot satisfy it."),
        assessment(phone="unavailable", reason="No permitted readable channel is established for this recipient."),
        assessment(phone="remaining", blocker="account_locked", reason="The current named account is locked."),
        assessment(phone="remaining", blocker="user_only_verification", reason="Password was accepted; approve on the separate device."),
    ]:
        r = {"inventory": deepcopy(INVENTORY), "goal": ("Read the member number for named@example.test only" if a["recipient_options"][1]["status"] == "not_applicable" else "Read my member number"), "actions": [handoff(a)]}
        with _offline_activity_edges():
            await owning_fixture("empty", auth_review=r)
        assert not r.get("executed"), "handoff must never retarget a restricted or accepted account"
        assert r["result"]["auth_assessment"] == a
        observations.append({"case": a["reason"], "decisions": len(r["contexts"]), "inputs": 0})
    # A finite method can have more than two supplied recipients. Each failed
    # operation leaves only the explicitly reported next one; no fixture member
    # lookup, automatic input or new identity generation is involved.
    addresses = ["one@example.test", "two@example.test", "three@example.test"]
    inventory = {"realm": "shop.example", "email_otp": {"available": True, "connected_emails": addresses}}
    actions = []
    for i, address in enumerate(addresses):
        rows = [{"method": "email_otp", "recipient": value,
                 "status": "exhausted" if j < i else "remaining",
                 "evidence": "Observed individual rejection" if j < i else "Permitted supplied inbox on the current email form",
                 "evidence_steps": [3*j+3] if j < i else []} for j,value in enumerate(addresses)]
        actions.extend([handoff({"auth_realm": "shop.example", "page_url": URL,
                               "blocker": "automated_options_exhausted", "reason": "Assess the remaining permitted recipients", "recipient_options": rows}),
                        {"action": "input_text", "index": 7, "params": {"text": address}},
                        {"action": "click", "index": 8, "params": {}}])
    actions.append(handoff({"auth_realm": "shop.example", "page_url": URL,
                           "blocker": "automated_options_exhausted", "reason": "All three supplied recipients were individually rejected",
                           "recipient_options": [{"method": "email_otp", "recipient": v, "status": "exhausted", "evidence": "Observed individual rejection", "evidence_steps": [3*j+3]} for j,v in enumerate(addresses)]}))
    finite = {"inventory": inventory, "actions": actions}
    with _offline_activity_edges():
        await owning_fixture("empty", auth_review=finite)
    assert [x["params"]["text"] for x in finite["executed"] if x["action"] == "input_text"] == addresses
    assert len(finite["contexts"]) == 10
    observations.append({"case": "three_email_candidate_exhaustion", "decisions": 10, "inputs": 3})
    # Malformed/stale/foreign receipts return factual context through the real
    # activity; they cannot send an assistance request on their first turn.
    for case in ("missing", "stale", "duplicate", "foreign_receipt"):
        invalid = assessment(phone="unavailable")
        if case == "missing":
            invalid = None
        elif case == "stale":
            invalid["page_url"] = "https://stale.example/"
        elif case == "duplicate":
            invalid["recipient_options"].append(deepcopy(invalid["recipient_options"][0]))
        else:
            invalid["recipient_options"][1].update(status="exhausted", evidence_steps=[999])
        corrected = assessment(phone="unavailable", reason="No applicable readable recipient remains")
        r = {"inventory": deepcopy(INVENTORY), "actions": [handoff(invalid), handoff(corrected)]}
        with _offline_activity_edges():
            await owning_fixture("empty", auth_review=r)
        assert "authentication_assessment_incomplete" in str(r["contexts"][1]["turn_messages"])
        assert not r.get("executed")
        observations.append({"case": case, "decisions": 2, "inputs": 0})
    from domains.spawn_browser_agent_v3.auth_assessment import auth_assistance_assessment_result as check
    def result(a):
        return check(a, auth_options=INVENTORY, auth_realm="shop.example", current_url=URL, action_history=[{"step":3}])
    for mutation in [lambda a: a.update(page_url="https://elsewhere.test/"),
                     lambda a: a["recipient_options"].append(deepcopy(a["recipient_options"][0])),
                     lambda a: a["recipient_options"].pop(),
                     lambda a: a["recipient_options"][0].update(recipient="foreign@example.test")]:
        a=assessment();mutation(a);assert result(a)["error"]=="authentication_assessment_incomplete"
    absent = assessment(phone="exhausted");absent["recipient_options"][1]["evidence_steps"]=[999]
    assert result(absent)["error"] == "authentication_assessment_incomplete"
    assert result(None)["error"]=="authentication_assessment_incomplete"
    assert result(assessment(phone="remaining"))["remaining_recipient_options"][0]["recipient"]=="+15550000002"
    assert result(assessment(phone="exhausted")) is None  # unregistered recipient is a bounded exhausted operation
    # The model's structured choice must survive the actual native normalizer.
    from providers.rose.browser_use import _normalize_action_params
    a=assessment();assert _normalize_action_params("request_user_assistance_for_authentication", "request_user_assistance_for_authentication", {"auth_assessment":a}, {}, None)=={"auth_assessment":a}

    from browser_tools.schemas import RequestUserAssistanceForAuthenticationBrowserTool
    from pydantic import ValidationError
    assert RequestUserAssistanceForAuthenticationBrowserTool.model_validate({"tool": "request_user_assistance_for_authentication", "auth_assessment": assessment()}).auth_assessment.blocker == "automated_options_exhausted"
    try:
        RequestUserAssistanceForAuthenticationBrowserTool.model_validate({"tool": "request_user_assistance_for_authentication"})
    except ValidationError:
        pass
    else:
        raise AssertionError("Native tool schema still permits an empty escalation decision")

    from providers.rose.browser_use import build_browser_use_tools, normalize_browser_use_response
    tools = build_browser_use_tools(["request_user_assistance_for_authentication"])
    assert "auth_assessment" in tools[0]["input_schema"]["required"]
    normal = normalize_browser_use_response({"action": [{"request_user_assistance_for_authentication": {"auth_assessment": assessment()}}]})
    assert normal["params"]["auth_assessment"] == assessment()
    from domains.spawn_browser_agent_v3.config import MAX_ITERATIONS
    invalid = assessment();invalid["page_url"]="https://stale.example/"
    bounded = {"inventory": deepcopy(INVENTORY), "actions": [handoff(invalid)], "expected_status": "max_iterations"}
    with _offline_activity_edges():
        await owning_fixture("empty", resume_step_count=MAX_ITERATIONS-1, auth_review=bounded)
    assert not bounded.get("executed")

    observations.append({"case": "invalid_at_original_budget", "decisions": len(bounded["contexts"]), "inputs": 0})
    return {"activity_cases": observations, "schema_and_normalizer": "passed", "missing_stale_duplicate_foreign_receipts": "passed"}
