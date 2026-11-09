"""Typed payment history keeps URL text, never page media or private values."""

import copy
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

SECRET = "receipt-private-value"
URLS = [f"https://images.example.test/product-{i}.png" for i in range(3)]


def receipt():
    return {
        "success": True,
        "status": "payment_card_ready",
        "payment_request": {
            "merchant": "Fixture",
            "currency": "USD",
            "line_items": [
                {
                    "name": f"Item {i}",
                    "quantity": 1,
                    "unit_price_cents": 1000,
                    "product_url": f"https://shop.example.test/product-{i}",
                    "image_url": url,
                }
                for i, url in enumerate(URLS)
            ],
            "total_cents": 3000,
        },
        "message": SECRET,
        "screenshot": "PRIVATE_RASTER",
        "extra": {"image_url": "https://untrusted.example.test/nested.png"},
    }


def policy():
    from browser_tools.dom_service import DOMService

    dom = DOMService("ws://unused")
    dom.register_secret_refs({"pwd:fixture": SECRET})
    dom.mark_secret_used()
    return dom


def assert_receipt(value):
    assert [item.get("image_url") for item in value["payment_request"]["line_items"]] == URLS
    assert SECRET not in json.dumps(value)
    assert "screenshot" not in value and "image_url" not in value["extra"]


async def test_payment_history_storage_read_and_restore():
    from browser_tools.dom_service import ActionHistory

    dom = policy()
    history = ActionHistory()
    entry = await history.record_action(dom, "request_payment_card", result=receipt())
    assert_receipt(entry.result)
    assert_receipt(history.get_entries()[0]["result"])
    restored = ActionHistory()
    restored.bind_dom_service(dom)
    restored.restore_entries(json.loads(json.dumps(history.get_entries())))
    assert_receipt(restored.get_entries()[0]["result"])
    alias = receipt()
    alias["payment_request"]["lineItems"] = alias["payment_request"].pop("line_items")
    entry = await history.record_action(dom, "request_payment_card", result=alias)
    assert [item.get("image_url") for item in entry.result["payment_request"]["lineItems"]] == URLS


async def test_payment_history_resume_and_export():
    from browser_tools.dom_service import ActionHistory, ActionHistoryEntry
    from domains.spawn_browser_agent_v3 import handler
    from helpers.jev_progress import browser_prefix_events

    dom = policy()
    history = ActionHistory()
    history.bind_dom_service(dom)
    history._entries = [ActionHistoryEntry(step=1, action="request_payment_card", result=receipt())]
    state = handler._browser_resume_continuity_state(action_history=history, visited_urls=[], verifier_checkpoints=[])
    assert_receipt(state["action_history"][0]["result"])
    # get_entries is the typed input to the native export projection.
    text = json.dumps(browser_prefix_events(history.get_entries()))
    assert all(url in text for url in URLS) and SECRET not in text


async def test_payment_history_llm_reprojection():
    from browser_tools.dom_service import ActionHistoryEntry
    from domains.spawn_browser_agent_v3 import handler

    dom = policy()
    captured = []

    async def call(**kwargs):
        captured.append(kwargs)
        return {"action": {"action": "done", "params": {}}}

    client = SimpleNamespace(complete_browser_use=call)
    entry = ActionHistoryEntry(step=1, action="request_payment_card", result=receipt()).to_dict()
    await handler._call_browser_use_with_rotation(
        rose_client=client,
        task="Fixture",
        dynamic_system_context="",
        turn_messages=[],
        browser_state={},
        action_entries=[entry],
        config=None,
        user_id="fixture",
        agent_id="fixture",
        iteration=1,
        token_state=handler.ClaudeTokenState(),
        gpt_token=None,
        gpt_account_id=None,
        gpt_token_source=None,
        gpt_token_pool_id=None,
        browser_use_mode=None,
        dom_service=dom,
    )
    assert_receipt(captured[0]["action_history"][0]["result"])


async def test_payment_history_verifier_projection():
    from browser_tools.dom_service import ActionHistory, ActionHistoryEntry
    from domains.spawn_browser_agent_v3 import handler, service

    dom = policy()
    history = ActionHistory()
    history.bind_dom_service(dom)
    history._entries = [ActionHistoryEntry(step=1, action="request_payment_card", result=receipt())]
    with patch.object(service, "_session_files_for_listing", AsyncMock(return_value=[])):
        context = await service.build_browser_verifier_context(
            "Fixture", "https://shop.example.test", {}, history, None, "fixture"
        )
    visible = handler._model_visible_browser_verifier_context(context, dom, {})
    text = json.dumps(visible)
    assert all(url in text for url in URLS) and SECRET not in text


async def test_payment_history_rejects_media_and_evaluate_spoofs():
    from browser_tools.dom_service import ActionHistory

    dom = policy()
    history = ActionHistory()
    for action in ["evaluate", "click"]:
        entry = await history.record_action(dom, action, result={"value": receipt(), "action": "request_payment_card"})
        assert "image_url" not in json.dumps(entry.result)
    visible = dom.model_visible_value(receipt())
    assert "image_url" not in json.dumps(visible)
    for url in ["data:image/png;base64,PRIVATE", "file:///private/image", "javascript:secret"]:
        value = receipt()
        value["payment_request"]["line_items"][0]["image_url"] = url
        entry = await history.record_action(dom, "request_payment_card", result=value)
        assert "image_url" not in entry.result["payment_request"]["line_items"][0]
    value = receipt()
    value["payment_request"]["line_items"][0]["image_url"] = "https://images.example.test/" + SECRET
    entry = await history.record_action(dom, "request_payment_card", result=value)
    assert SECRET not in json.dumps(entry.result)
    from urllib.parse import quote

    value = receipt()
    value["payment_request"]["line_items"][0]["image_url"] = "https://images.example.test/" + quote(SECRET, safe="")
    entry = await history.record_action(dom, "request_payment_card", result=value)
    assert SECRET not in json.dumps(entry.result) and quote(SECRET, safe="") not in json.dumps(entry.result)
