import asyncio
import copy

from benchmarks.benchmark_tasks import get_task_by_name
from benchmarks.google_oauth_demo_check import check_google_oauth_demo_trace
from tools.google_oauth_demo import google_oauth_demo


def _transcript():
    class WorkflowStub:
        goal = get_task_by_name("google-oauth").prompt

        def __init__(self):
            self.messages = [
                {"role": "ASSISTANT", "metadata": {"tool_calls": [{"tool": "google_workspace_run"}]}}
            ]

        async def _handle_tool_event(self, event, tool_call_id, tool_name):
            self.messages.append({
                "role": "TOOL",
                "message": event.message,
                "metadata": {
                    **(event.metadata or {}),
                    "title": event.title,
                    "toolName": tool_name,
                    "toolCallId": tool_call_id,
                    "toolStatus": event.status.value,
                },
            })

    workflow = WorkflowStub()
    fixture = asyncio.run(google_oauth_demo(workflow, {"tool": "google_workspace_run"}, "call-workspace"))["result"]
    workflow.messages.append({"role": "ASSISTANT", "metadata": {"tool_calls": [{"tool": "attempt_completion"}]}})
    outputs = {
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
    workflow.messages.append({
        "role": "TOOL",
        "message": "Completed the requested Gmail, Calendar, Drive, and account tasks.",
        "metadata": {
            "toolName": "completion_summary",
            "toolStatus": "FINISHED",
            "completionSummary": {
                "summary": "Completed the requested Gmail, Calendar, Drive, and account tasks.",
                "outputs": [{"key": key, "value": value} for key, value in outputs.items()],
            },
        },
    })
    return {"messages": workflow.messages}


def test_google_oauth_checker_grades_visible_flow_and_completion_without_a_model():
    transcript = _transcript()
    assert check_google_oauth_demo_trace(transcript)[0]
    assert "demo" not in str(transcript).lower()

    api_shape = copy.deepcopy(transcript)
    for message in api_shape["messages"]:
        if "message" in message:
            message["text"] = message.pop("message")
    assert check_google_oauth_demo_trace(api_shape)[0]

    fetched_out_of_order = copy.deepcopy(transcript)
    notes = [message for message in fetched_out_of_order["messages"] if (message.get("metadata") or {}).get("fixtureProgress")]
    cards = [message for message in fetched_out_of_order["messages"] if (message.get("metadata") or {}).get("fixtureRow")]
    for item in notes + cards:
        fetched_out_of_order["messages"].remove(item)
    fetched_out_of_order["messages"][1:1] = list(reversed(notes + cards))
    assert check_google_oauth_demo_trace(fetched_out_of_order)[0]

    missing_card = copy.deepcopy(transcript)
    card = next(message for message in missing_card["messages"] if (message.get("metadata") or {}).get("toolName") == "gmail_send_draft")
    missing_card["messages"].remove(card)
    assert not check_google_oauth_demo_trace(missing_card)[0]

    wrong_sent = copy.deepcopy(transcript)
    card = next(message for message in wrong_sent["messages"] if (message.get("metadata") or {}).get("toolName") == "gmail_send_draft")
    card["metadata"]["fixtureRow"]["result"] = {"sent": False, "in_sent": False}
    assert not check_google_oauth_demo_trace(wrong_sent)[0]

    missing_progress = copy.deepcopy(transcript)
    note = next(message for message in missing_progress["messages"] if (message.get("metadata") or {}).get("toolCallId") == "call-workspace-progress-9")
    missing_progress["messages"].remove(note)
    assert not check_google_oauth_demo_trace(missing_progress)[0]

    visible_label = copy.deepcopy(transcript)
    visible_label["messages"][1]["message"] = "DEMO"
    assert not check_google_oauth_demo_trace(visible_label)[0]

    wrong_answer = copy.deepcopy(transcript)
    wrong_answer["messages"][-1]["metadata"]["completionSummary"]["outputs"][1]["value"] = "No unread mail"
    assert not check_google_oauth_demo_trace(wrong_answer)[0]

    spawned = copy.deepcopy(transcript)
    spawned["messages"].insert(1, {"role": "ASSISTANT", "metadata": {"tool_calls": [{"tool": "spawn_agent"}]}})
    assert not check_google_oauth_demo_trace(spawned)[0]
