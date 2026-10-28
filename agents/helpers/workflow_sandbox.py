"""Temporal workflow sandbox restrictions shared by the worker and workflow tests."""

from __future__ import annotations

from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner, SandboxRestrictions


def workflow_sandbox_restrictions() -> SandboxRestrictions:
    """Sandbox restrictions every production workflow worker runs under.

    Workflow tests that run AgentWorkflow must use these, not
    ``with_passthrough_all_modules()``: a module that is only imported lazily
    from workflow code is re-imported inside the sandbox, where restricted
    calls such as ``os.getenv`` fail the workflow task.
    """
    return SandboxRestrictions.default.with_passthrough_modules(
        # These libraries use threading.local which isn't allowed in the sandbox,
        # but they're only used in activities, not workflows
        "rich",
        "rich.console",
        "markdown_it",
        "markdown_it_py",
        "pygments",
        "httpx",
        "sniffio",
        # Workflow loggers must use the worker's configured processors and
        # contextvars, without rebuilding the logging package on every replay.
        "structlog",
        # helpers.llm uses threading.Lock via OpenAI/instructor clients
        # but workflow only calls activities via execute_activity, not directly
        "helpers.llm",
        # helpers.attachments downloads files from storage using httpx
        # called from build_llm_messages when resolving file attachments
        "helpers.attachments",
        # Tool schemas and prompts built inside run_agent read these env
        # switches; they are fixed for the life of the worker process.
        "utils.kill_switches",
        # Env-backed settings, also fixed for the life of the worker process.
        # Re-importing config per workflow instance re-ran load_dotenv on
        # every sandbox instance (activity modules call load_config() at
        # import); through the sandbox's os.environ proxy that cost ~0.4s per
        # workflow task, so cache-miss replays slowed by an order of magnitude.
        "config",
    )


def production_workflow_runner() -> SandboxedWorkflowRunner:
    return SandboxedWorkflowRunner(restrictions=workflow_sandbox_restrictions())
