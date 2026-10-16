"""Offline integrated controls for explicit per-recipient escalation decisions."""
from copy import deepcopy
from otp_retry_behavior import _offline_activity_edges

URL = "https://shop.example/login/verify"
INVENTORY = {"realm": "shop.example", "minted": {"id": "owned", "email": "owned@example.test", "phone": "+15550000002"}}

def assessment(*, phone="not_applicable", email="not_applicable", blocker="automated_options_exhausted", reason="The page rejected this recipient; no other applicable options remain."):
    return {"auth_realm": "shop.example", "page_url": URL, "blocker": blocker,
            "reason": reason, "recipient_options": [
                {"method": "email_otp", "recipient": "owned@example.test", "status": email, "evidence": "This form accepts phone numbers only."},
                {"method": "sms_otp", "recipient": "+15550000002", "status": phone, "evidence": "Observed recipient-specific result, not a site membership assertion.", "evidence_steps": [2,3] if phone == "exhausted" else []},
            ]}

def handoff(a):
    return {"action": "request_user_assistance_for_authentication", "thinking": "Assess the current options", "params": {"auth_assessment": a}}

async def assert_auth_assessment_controls(owning_fixture):
    observations = []
    # Every blocker uses the same inventory-accounting boundary. A label alone
    # cannot make supplied recipients disappear; no alternate action is forced.
    from domains.spawn_browser_agent_v3.auth_assessment import auth_assistance_assessment_result as uniform_check
    for blocker in ("automated_options_exhausted", "user_only_verification", "account_locked"):
        missing_rows = assessment(phone="unavailable", blocker=blocker)
        missing_rows["recipient_options"] = []
        rejected = uniform_check(missing_rows, auth_options=INVENTORY, auth_realm="shop.example", current_url=URL, action_history=[])
        corrected = assessment(phone="unavailable", blocker=blocker, reason="Current named account requires user action; no permitted readable channel remains.")
        r = {"inventory": deepcopy(INVENTORY), "actions": [handoff(missing_rows), handoff(corrected)]}
        with _offline_activity_edges(handoff_review={"score": 1.0, "reasoning": "Scripted supported human transfer in this owning fixture", "usage": {}}):
            await owning_fixture("empty", auth_review=r)
        assert len(r["contexts"]) == 2
        assert rejected and rejected["error"] == "authentication_assessment_incomplete", "blocker must not bypass supplied-recipient accounting"
        assert "authentication_assessment_incomplete" in str(r["contexts"][1]["turn_messages"])
        assert not r.get("executed"), "accounting must not submit an alternate identity"
        assert r["result"]["auth_assessment"] == corrected
        # Exceptional blocker labels also retain the existing binding controls.
        for mutate in (lambda a: a["recipient_options"].append(deepcopy(a["recipient_options"][0])),
                       lambda a: a["recipient_options"][0].update(recipient="foreign@example.test"),
                       lambda a: a["recipient_options"][1].update(status="exhausted", evidence_steps=[999])):
            invalid = deepcopy(corrected)
            mutate(invalid)
            assert uniform_check(invalid, auth_options=INVENTORY, auth_realm="shop.example", current_url=URL, action_history=[])["error"] == "authentication_assessment_incomplete"
        # A genuinely empty inventory still permits an empty disposition list.
        assert uniform_check(missing_rows, auth_options={}, auth_realm="shop.example", current_url=URL, action_history=[]) is None
        remaining = assessment(phone="remaining", blocker=blocker)
        assert uniform_check(remaining, auth_options=INVENTORY, auth_realm="shop.example", current_url=URL, action_history=[])["error"] == "authentication_options_remaining"
        observations.append({"case": "uniform_accounting_" + blocker, "decisions": 2, "inputs": 0})
    # The old real activity pauses immediately at the first declaration, even
    # though that same declaration says an applicable supplied operation remains.
    before_other_recipient = assessment(phone="remaining")
    before_other_recipient["attempted_recipient_options"] = [{"method": "sms_otp", "recipient": "+15550000001", "status": "exhausted", "evidence": "The submitted personal recipient was rejected", "evidence_steps": [1,3]}]
    final = assessment(phone="exhausted");final["recipient_options"][1]["evidence_steps"] = [5,7]
    final["attempted_recipient_options"] = deepcopy(before_other_recipient["attempted_recipient_options"])
    r = {"inventory": deepcopy(INVENTORY), "actions": [
        {"action": "input_text", "index": 7, "params": {"text": "+15550000001"}},
        {"action": "click", "index": 8, "params": {}},
        {"action":"read_browser_state", "params":{}},
        handoff(before_other_recipient),
        {"action": "input_text", "index": 7, "params": {"text": "+15550000002"}, "thinking": "Use the supplied phone on the current form"},
        {"action": "click", "index": 8, "params": {}, "thinking": "Submit the supplied recipient"},
        {"action":"read_browser_state", "params":{}},
        handoff(final),
    ]}
    with _offline_activity_edges(handoff_review={"score": 1.0, "reasoning": "Scripted supported human transfer in this owning fixture", "usage": {}}):
        await owning_fixture("empty", auth_review=r)
    assert [x["params"]["text"] for x in r["executed"] if x["action"] == "input_text"] == ["+15550000001", "+15550000002"]
    assert "action_step" in str(r["contexts"][7]["turn_messages"])
    assert "authentication_options_remaining" in str(r["contexts"][4]["turn_messages"])
    assert r["result"]["auth_assessment"] == final
    observations.append({"case": "remaining_sms_to_native_input", "decisions": len(r["contexts"]), "inputs": 2})
    # Named account exclusion / unknown reader are deliberate model judgements,
    # never automatic ownership=>registration or automatic account retargeting.
    for a in [
        assessment(phone="not_applicable", reason="The actual goal names a different account; these recipients cannot satisfy it."),
        assessment(phone="unavailable", reason="No permitted readable channel is established for this recipient."),
        assessment(phone="not_applicable", blocker="account_locked", reason="The current named account is locked."),
        assessment(phone="not_applicable", blocker="user_only_verification", reason="Password was accepted; approve on the separate device."),
    ]:
        r = {"inventory": deepcopy(INVENTORY), "goal": ("Read the member number for named@example.test only" if a["recipient_options"][1]["status"] == "not_applicable" else "Read my member number"), "actions": [handoff(a)]}
        with _offline_activity_edges(handoff_review={"score": 1.0, "reasoning": "Scripted supported human transfer in this owning fixture", "usage": {}}):
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
                 "evidence_steps": [4*j+2,4*j+4] if j < i else []} for j,value in enumerate(addresses)]
        actions.extend([handoff({"auth_realm": "shop.example", "page_url": URL,
                               "blocker": "automated_options_exhausted", "reason": "Assess the remaining permitted recipients", "recipient_options": rows}),
                        {"action": "input_text", "index": 7, "params": {"text": address}},
                        {"action": "click", "index": 8, "params": {}},
                        {"action":"read_browser_state", "params":{}}])
    actions.append(handoff({"auth_realm": "shop.example", "page_url": URL,
                           "blocker": "automated_options_exhausted", "reason": "All three supplied recipients were individually rejected",
                           "recipient_options": [{"method": "email_otp", "recipient": v, "status": "exhausted", "evidence": "Observed individual rejection", "evidence_steps": [4*j+2,4*j+4]} for j,v in enumerate(addresses)]}))
    finite = {"inventory": inventory, "actions": actions}
    with _offline_activity_edges(handoff_review={"score": 1.0, "reasoning": "Scripted supported human transfer in this owning fixture", "usage": {}}):
        await owning_fixture("empty", auth_review=finite)
    assert [x["params"]["text"] for x in finite["executed"] if x["action"] == "input_text"] == addresses
    assert len(finite["contexts"]) == 13
    observations.append({"case": "three_email_candidate_exhaustion", "decisions": 13, "inputs": 3})
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
        with _offline_activity_edges(handoff_review={"score": 1.0, "reasoning": "Scripted supported human transfer in this owning fixture", "usage": {}}):
            await owning_fixture("empty", auth_review=r)
        assert "authentication_assessment_incomplete" in str(r["contexts"][1]["turn_messages"])
        assert not r.get("executed")
        observations.append({"case": case, "decisions": 2, "inputs": 0})
    # Account-label aliases are rendered by the real authoritative formatter.
    from domains.spawn_browser_agent_v3.auth_assessment import auth_recipient_options
    from domains.spawn_browser_agent_v3.service_crypto import build_auth_options_prompt_section
    for key in ("email", "agentEmail", "agent_email", "accountLabel", "account_label"):
        inv = {"realm":"shop.example", "minted":{key:"label@example.test"}}
        assert "label@example.test" in build_auth_options_prompt_section(inv)[0]
        assert auth_recipient_options(inv) == [{"method":"email_otp","recipient":"label@example.test"}]
    assert auth_recipient_options({"minted":{"accountLabel":"arbitrary human label"}}) == []
    label_rows = [{"method":"email_otp","recipient":"label@example.test","status":"remaining","evidence":"Supplied verifiable recipient on the form","evidence_steps":[]}]
    label_first = {"auth_realm":"shop.example","page_url":URL,"blocker":"automated_options_exhausted","reason":"Assess this supplied recipient","recipient_options":label_rows}
    label_last=deepcopy(label_first);label_last["recipient_options"][0].update(status="exhausted", evidence="Observed recipient rejection", evidence_steps=[2,4])
    labelled={"inventory":{"realm":"shop.example","minted":{"accountLabel":"label@example.test"}}, "actions":[handoff(label_first),{"action":"input_text","index":7,"params":{"text":"label@example.test"}},{"action":"click","index":8,"params":{}},{"action":"read_browser_state","params":{}},handoff(label_last)]}
    with _offline_activity_edges(handoff_review={"score": 1.0, "reasoning": "Scripted supported human transfer in this owning fixture", "usage": {}}):
        await owning_fixture("empty",auth_review=labelled)
    assert [a["params"]["text"] for a in labelled["executed"] if a["action"]=="input_text"] == ["label@example.test"]
    observations.append({"case":"label_only_minted_identity","decisions":5,"inputs":1})
    from domains.spawn_browser_agent_v3.auth_assessment import auth_assistance_assessment_result as check
    def result(a):
        return check(a, auth_options=INVENTORY, auth_realm="shop.example", current_url=URL, action_history=[{"step":2,"action":"input_text","params":{"text":"+15550000002"}}, {"step":3,"action":"click","result":{"url":URL, "title":"Unknown account"}}])
    for mutation in [lambda a: a.update(page_url="https://elsewhere.test/"),
                     lambda a: a["recipient_options"].append(deepcopy(a["recipient_options"][0])),
                     lambda a: a["recipient_options"].pop(),
                     lambda a: a["recipient_options"][0].update(recipient="foreign@example.test")]:
        a=assessment();mutation(a);assert result(a)["error"]=="authentication_assessment_incomplete"
    absent = assessment(phone="exhausted");absent["recipient_options"][1]["evidence_steps"]=[999]
    assert result(absent)["error"] == "authentication_assessment_incomplete"
    foreign_history = [{"step":2,"action":"input_text","params":{"text":"+15550000001"}}, {"step":3,"action":"click","result":{"url":URL, "title":"Unknown account for that other recipient"}}]
    assert check(assessment(phone="exhausted"), auth_options=INVENTORY, auth_realm="shop.example", current_url=URL, action_history=foreign_history)["error"] == "authentication_assessment_incomplete"
    ack_only=assessment(phone="exhausted");ack_only["recipient_options"][1]["evidence_steps"]=[2]
    assert result(ack_only)["error"] == "authentication_assessment_incomplete"
    assert check(assessment(phone="exhausted"), auth_options=INVENTORY, auth_realm="shop.example", current_url=URL, action_history=[{"step":2,"action":"input_text","params":{"text":"+15550000002"}},{"step":3,"action":"click","result":{"success":True}}])["error"] == "authentication_assessment_incomplete"
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
    with _offline_activity_edges(handoff_review={"score": 1.0, "reasoning": "Scripted supported human transfer in this owning fixture", "usage": {}}):
        await owning_fixture("empty", resume_step_count=MAX_ITERATIONS-1, auth_review=bounded)
    assert not bounded.get("executed")

    observations.append({"case": "invalid_at_original_budget", "decisions": len(bounded["contexts"]), "inputs": 0})
    return {"activity_cases": observations, "schema_and_normalizer": "passed", "missing_stale_duplicate_foreign_receipts": "passed"}
