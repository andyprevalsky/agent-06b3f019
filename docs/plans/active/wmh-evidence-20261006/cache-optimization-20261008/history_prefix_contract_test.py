import json
import pytest
from wmh.providers.base import Message
from benchmarks import wmh_rose_provider
from benchmarks.wmh_rose_provider import _to_rose_messages

def _native_history_cache_request(history):
    return {
        "task": {"initial_context": {"company": "unchanged"}, "instruction": "Inspect", "task_id": "scope",
                 "tools": [{"name": "browser"}]},
        "grounding_schema_version": "test",
        "grounding_contexts": [{"context_id": "one", "instruction": "formatting"}],
        "grounded_examples": [{"context_ref": "one", "observation": "observed"}],
        "visible_conversation": history,
        "environment_state": {"scratchpad": "original", "structured": {"clock": 10}},
        "candidate_response": {"tool_calls": [{"call_id": "next", "name": "browser", "arguments": {}}]},
        "future_field": {"value": "retain π"},
    }


def _native_history_batch(*call_ids):
    return [{"role": "assistant", "assistant_action": {"tool_calls": [
        {"call_id": call_id, "name": "browser", "arguments": {}} for call_id in call_ids
    ]}}, *[{"role": "tool", "tool_call_id": call_id, "content": "result " + call_id} for call_id in call_ids]]


def _marked_native_prefixes(request):
    from benchmarks.wmh_rose_provider import _prompt_text
    from providers.rose.waterfall import build_openrouter_body

    messages = _to_rose_messages("fixed system", [Message(role="user", content=json.dumps(request))])
    wire = build_openrouter_body(model="openai/gpt-6.1-sol", messages=messages, tools=None,
                                 tool_choice=None, response_format=None, temperature=None,
                                 max_tokens=16384, seed=None, effort="xhigh", cache_namespace="wmh:session:test")
    assert json.loads(_prompt_text(wire["messages"][1]["content"])) == request
    assert wire["messages"][0] == {"role": "system", "content": "fixed system"}
    assert wmh_rose_provider._wmh_cache_key_material({"messages": messages}) == (
        wmh_rose_provider._wmh_cache_key_material({"messages": [
            {"role": "system", "content": "fixed system"},
            {"role": "user", "content": json.dumps(request)},
        ]})
    )
    text = ""
    prefixes = []
    for block in wire["messages"][1]["content"]:
        text += block["text"]
        if "cache_control" in block:
            prefixes.append(text)
            assert '"environment_state":' not in text
            assert '"candidate_response":' not in text
    assert 1 <= len(prefixes) <= 4
    return prefixes


def test_native_cache_reuses_completed_batch_when_history_grows():
    history = _native_history_batch("a", "b") + _native_history_batch("c")
    first = _native_history_cache_request(history)
    second = _native_history_cache_request(history + _native_history_batch("d", "e"))
    second["environment_state"]["structured"]["clock"] = 11
    second["candidate_response"]["tool_calls"][0]["call_id"] = "different-next"
    old = _marked_native_prefixes(first)
    new = _marked_native_prefixes(second)
    assert old[-1] in new
    assert old[-1].endswith('"content":"result c"}')
    assert new[-1].endswith('"content":"result e"}')
    assert old[-1] != new[-1]


def test_native_cache_does_not_mark_incomplete_parallel_result_batch():
    complete = _native_history_batch("a", "b")
    incomplete = _marked_native_prefixes(_native_history_cache_request(complete[:-1]))
    finished = _marked_native_prefixes(_native_history_cache_request(complete))
    assert not any('"content":"result a"' in prefix for prefix in incomplete)
    assert finished[-1].endswith('"content":"result b"}')


@pytest.mark.parametrize("history", [None, "unrecognized future representation", [{"role": "user", "content": "new"}]])
def test_native_cache_preserves_unrecognized_history_and_future_fields(history):
    _marked_native_prefixes(_native_history_cache_request(history))
