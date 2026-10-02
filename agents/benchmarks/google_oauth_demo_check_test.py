import copy
import json

from benchmarks.google_oauth_demo_check import check_google_oauth_demo_trace
from domains.api_request.google_oauth_demo_fixture import run_fixture


def _transcript():
    fixture = run_fixture()
    parent_id = "call-demo"
    messages = [
        {"role": "ASSISTANT", "metadata": {"tool_calls": [{"tool": "google_oauth_demo"}]}},
    ]
    for index, row in enumerate(fixture["rows"], start=1):
        messages.append({
            "role": "TOOL",
            "message": json.dumps(row),
            "metadata": {
                "demoFixture": True,
                "demoParentToolCallId": parent_id,
                "toolCallId": f"{parent_id}-demo-{index}",
                "toolStatus": "FINISHED",
                "toolName": row["tool"],
                "title": f"DEMO · {row['tool']}",
            },
        })
    messages.append({
        "role": "TOOL",
        "message": json.dumps(fixture),
        "metadata": {"toolName": "google_oauth_demo", "toolStatus": "FINISHED", "toolCallId": parent_id},
    })
    messages.append({"role": "ASSISTANT", "metadata": {"tool_calls": [{"tool": "attempt_completion"}]}})
    outputs = {
        "demo_notice": fixture["label"],
        "connected_account": fixture["account"],
        "unread_email_summary": fixture["answers"][0],
        "reply_to_sam": fixture["answers"][1],
        "archive_acme_newsletter": fixture["answers"][2],
        "tomorrow_calendar": fixture["answers"][3],
        "friday_lunch": fixture["answers"][4],
        "lease_end_date": fixture["answers"][5],
        "lease_renewal": fixture["answers"][6],
        "final_disconnected": True,
    }
    messages.append({
        "role": "TOOL",
        "metadata": {
            "toolName": "completion_summary",
            "toolStatus": "FINISHED",
            "completionSummary": {
                "summary": fixture["label"],
                "outputs": [{"key": key, "value": value} for key, value in outputs.items()],
            },
        },
    })
    return {"messages": messages}


def test_google_oauth_demo_checker_grades_cards_and_completion_without_a_model():
    transcript = _transcript()
    assert check_google_oauth_demo_trace(transcript)[0]

    missing_card = copy.deepcopy(transcript)
    missing_card["messages"].pop(6)
    assert not check_google_oauth_demo_trace(missing_card)[0]

    unlinked_card = copy.deepcopy(transcript)
    unlinked_card["messages"][6]["metadata"].pop("demoParentToolCallId")
    assert not check_google_oauth_demo_trace(unlinked_card)[0]

    wrong_sent = copy.deepcopy(transcript)
    wrong_sent["messages"][5]["message"] = json.dumps({
        **json.loads(wrong_sent["messages"][5]["message"]),
        "result": {"sent": False, "in_sent": False},
    })
    assert not check_google_oauth_demo_trace(wrong_sent)[0]

    wrong_answer = copy.deepcopy(transcript)
    wrong_answer["messages"][-1]["metadata"]["completionSummary"]["outputs"][2]["value"] = "No unread mail"
    assert not check_google_oauth_demo_trace(wrong_answer)[0]

    spawned = copy.deepcopy(transcript)
    spawned["messages"].insert(1, {"role": "ASSISTANT", "metadata": {"tool_calls": [{"tool": "spawn_agent"}]}})
    assert not check_google_oauth_demo_trace(spawned)[0]
