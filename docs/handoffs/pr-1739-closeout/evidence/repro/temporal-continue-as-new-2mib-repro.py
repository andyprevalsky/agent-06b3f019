import asyncio, datetime
from temporalio import workflow
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker, UnsandboxedWorkflowRunner

def ctx(): return [{"role": "TOOL", "text": "x" * 2600} for _ in range(420)]

@workflow.defn
class Handoff:
    @workflow.run
    async def run(self, mode: str, context: list, state: dict) -> str:
        if workflow.info().continued_run_id is not None:
            return "handed-off"
        c = ctx()
        # Same shape as AgentWorkflow._continuation_args: arg 6 context + resume_state.
        state = {"runtime_state": {"context": c}} if mode == "dup" else {"runtime_state": {}}
        workflow.continue_as_new(args=[mode, c, state])

async def attempt(env, mode):
    async with Worker(env.client, task_queue=f"q-{mode}", workflows=[Handoff], workflow_runner=UnsandboxedWorkflowRunner()):
        h = await env.client.start_workflow(Handoff.run, args=[mode, [], {}], id=f"wf-{mode}", task_queue=f"q-{mode}", task_timeout=datetime.timedelta(seconds=5))
        try:
            print(mode, "OK", await asyncio.wait_for(h.result(), 15))
        except Exception as e:
            fails = [x.workflow_task_failed_event_attributes.failure.message async for x in h.fetch_history_events() if x.HasField("workflow_task_failed_event_attributes")]
            print(mode, "STUCK:", type(e).__name__, "workflow task failures:", fails[:1]); await h.terminate("repro done")

async def main():
    args = ["--dynamic-config-value", "limit.blobSize.error=2097152", "--dynamic-config-value", "limit.blobSize.warn=524288"]
    async with await WorkflowEnvironment.start_local(dev_server_extra_args=args) as env:
        await attempt(env, "dup"); await attempt(env, "single")
asyncio.run(main())
