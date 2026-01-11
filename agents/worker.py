"""Temporal worker for Rose autonomous agents."""

import asyncio
import signal
import sys
import os
import logging
from dotenv import load_dotenv
from temporalio.client import Client, TLSConfig
from temporalio.worker import Worker
from temporalio.worker.workflow_sandbox import SandboxedWorkflowRunner, SandboxRestrictions
import structlog

# Load .env file before anything else
load_dotenv()

# Verify critical env vars
if not os.getenv("BACKEND_API_KEY"):
    print("❌ ERROR: BACKEND_API_KEY not found in environment")
    print("Please add BACKEND_API_KEY to your .env file")
    sys.exit(1)

from config import load_config
from workflows import AgentWorkflow
# User-configurable tools
from tools.spawn_sub_agents import spawn_sub_agents_activity
from tools.request_user_approval import create_approval_request_activity
from tools.send_sms import send_sms_activity
from tools.send_email import send_email_activity
from tools.spawn_browser_agent_v3 import spawn_browser_agent_activity_v3  # V3: browser-use + Rose API
from tools.spawn_claude_code_agent import spawn_claude_code_activity  # Claude Code in E2B sandbox
# New event-driven tools
from tools.deep_research import deep_research_activity
from tools.knowledge_base import query_blueprints_activity, save_blueprint_activity
from tools.web_search import web_search_activity
from tools.find_all import (
    find_all_ingest_activity,
    find_all_create_run_activity,
    find_all_poll_status_once_activity,
    find_all_get_results_activity,
)
from tools.enrich import (
    enrich_create_task_activity,
    enrich_poll_status_once_activity,
    enrich_get_task_results_activity,
)
from tools.monitor import monitor_activity
from tools.check_monitor_events import check_monitor_events_activity
from tools.search_user_network import search_user_network_activity
from tools.read_message_history import read_message_history_activity
from tools.x402_bazaar import search_x402_bazaar_activity, pay_for_x402_service_activity
# Helper activities (workflow orchestration, not exposed to LLM)
from helpers import (
    poll_new_messages,
    post_agent_message,
    call_llm,
    check_progress,
    call_llm_activity,
    update_agent_status,
    compress_context,
    generate_completion_summary,
    get_model_context_window,
    fetch_agent_tools,
    mark_finished,
    fetch_agent_config,
    check_user_usage,
    get_user_context,
)
from helpers.llm import call_planner_llm_activity, set_response_schema_activity
from helpers.messages import update_agent_tree_state
from helpers.save_tool_usage import save_tool_usage
from helpers.update_tokens import update_agent_tokens_activity
from health_server import run_health_server, set_worker_status

# Configure structured logging
logging.basicConfig(
    format="%(message)s",
    stream=sys.stdout,
    level=logging.DEBUG,
)

# Silence verbose browser-use CDP logging
logging.getLogger('browser_use').setLevel(logging.INFO)
logging.getLogger('browser_use.browser').setLevel(logging.INFO)
logging.getLogger('cdp_use').setLevel(logging.WARNING)
logging.getLogger('cdp_use.client').setLevel(logging.WARNING)
logging.getLogger('cdp_use.cdp').setLevel(logging.WARNING)
logging.getLogger('cdp_use.cdp.registry').setLevel(logging.WARNING)
logging.getLogger('websockets.client').setLevel(logging.WARNING)

structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.processors.JSONRenderer()
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    logger_factory=structlog.stdlib.LoggerFactory(),
)

logger = structlog.get_logger()


async def main():
    """Main worker entry point."""

    # Load configuration
    config = load_config()

    # Log environment mode
    is_production = config.environment == "production"
    print(f"🚀 [Agents] Mode: {'PRODUCTION' if is_production else 'DEVELOPMENT'}")
    print(f"   Rose API URL: {config.rose.api_url}")

    # Start health check server
    health_thread = run_health_server(config.health_check_port)
    set_worker_status(True)

    logger.info(
        "Starting Temporal worker",
        namespace=config.temporal.namespace,
        task_queue=config.temporal.task_queue,
        environment=config.environment
    )
    
    # Connect to Temporal Cloud
    client = await Client.connect(
        config.temporal.address,
        namespace=config.temporal.namespace,
        tls=TLSConfig(
            client_cert=None,
            client_private_key=None,
        ),
        rpc_metadata={
            "temporal-namespace": config.temporal.namespace,
            "Authorization": f"Bearer {config.temporal.api_key}"
        }
    )
    
    logger.info("Connected to Temporal Cloud")
    
    # Configure workflow sandbox to passthrough logging libraries
    # These libraries use threading.local which isn't allowed in the sandbox,
    # but they're only used in activities, not workflows
    sandbox_restrictions = SandboxRestrictions.default.with_passthrough_modules(
        "rich",
        "rich.console",
        "structlog.dev",
        "markdown_it_py",
        "pygments",
        "httpx",
        "sniffio",
        # helpers.llm uses threading.Lock via OpenAI/instructor clients
        # but workflow only calls activities via execute_activity, not directly
        "helpers.llm",
    )
    
    # Create worker with all workflows and activities
    worker = Worker(
        client,
        task_queue=config.temporal.task_queue,
        workflows=[
            AgentWorkflow
        ],
        activities=[
            spawn_sub_agents_activity,
            create_approval_request_activity,
            send_sms_activity,
            spawn_browser_agent_activity_v3,  # V3: browser-use + Rose API
            spawn_claude_code_activity,  # Claude Code in E2B sandbox
            send_email_activity,
            # New event-driven tool activities
            deep_research_activity,
            web_search_activity,
            # Find All activities (split into sub-activities)
            find_all_ingest_activity,
            find_all_create_run_activity,
            find_all_poll_status_once_activity,
            find_all_get_results_activity,
            # Enrich activities (split into sub-activities)
            enrich_create_task_activity,
            enrich_poll_status_once_activity,
            enrich_get_task_results_activity,
            monitor_activity,
            check_monitor_events_activity,
            save_tool_usage,
            search_user_network_activity,
            read_message_history_activity,
            # x402 Bazaar activities
            search_x402_bazaar_activity,
            pay_for_x402_service_activity,
            # Helper activities
            poll_new_messages,
            post_agent_message,
            call_llm,
            check_progress,
            call_llm_activity,
            call_planner_llm_activity,
            set_response_schema_activity,
            update_agent_status,
            compress_context,
            generate_completion_summary,
            get_model_context_window,
            fetch_agent_tools,
            query_blueprints_activity,
            save_blueprint_activity,
            mark_finished,
            fetch_agent_config,
            check_user_usage,
            get_user_context,
            update_agent_tokens_activity,
            update_agent_tree_state,
        ],
        max_concurrent_activities=config.temporal.max_concurrent_activities,
        max_concurrent_workflow_tasks=config.temporal.max_concurrent_workflows,
        max_cached_workflows=config.temporal.max_cached_workflows,
        workflow_runner=SandboxedWorkflowRunner(restrictions=sandbox_restrictions),
    )
    
    logger.info(
        "Worker configured",
        max_concurrent_activities=config.temporal.max_concurrent_activities,
        max_concurrent_workflows=config.temporal.max_concurrent_workflows
    )
    
    # Handle shutdown gracefully using asyncio signal handlers
    loop = asyncio.get_running_loop()
    shutdown_event = asyncio.Event()
    force_kill_event = asyncio.Event()
    shutdown_count = 0
    
    def handle_shutdown():
        nonlocal shutdown_count
        shutdown_count += 1
        
        if shutdown_count == 1:
            logger.info("🛑 Shutdown signal received (Ctrl+C again to force kill)...")
            shutdown_event.set()
        else:
            logger.warning("⚡ Force kill requested, exiting immediately!")
            force_kill_event.set()
            # Schedule force exit after a brief moment to let logs flush
            loop.call_later(0.5, lambda: os._exit(1))
    
    # Register signal handlers with the event loop (asyncio-compatible)
    loop.add_signal_handler(signal.SIGINT, handle_shutdown)
    loop.add_signal_handler(signal.SIGTERM, handle_shutdown)
    
    # Run worker
    logger.info("Worker started, waiting for tasks...")
    
    try:
        # Run worker and shutdown event concurrently
        worker_task = asyncio.create_task(worker.run())
        shutdown_task = asyncio.create_task(shutdown_event.wait())
        
        # Wait for either worker to stop or shutdown signal
        done, pending = await asyncio.wait(
            [worker_task, shutdown_task],
            return_when=asyncio.FIRST_COMPLETED
        )
        
        # If shutdown was signaled, shutdown worker cleanly with timeout
        if shutdown_task in done:
            logger.info("Stopping worker task (5s timeout, Ctrl+C again to force)...")
            
            # Create a force kill watcher
            async def force_kill_watcher():
                await force_kill_event.wait()
                raise SystemExit(1)
            
            force_task = asyncio.create_task(force_kill_watcher())
            
            try:
                # Try graceful shutdown with 5 second timeout
                await asyncio.wait_for(worker.shutdown(), timeout=5.0)
                logger.info("Worker shutdown complete, cancelling worker task...")
            except asyncio.TimeoutError:
                logger.warning("⚠️ Graceful shutdown timed out after 5s, forcing exit...")
                os._exit(1)
            finally:
                force_task.cancel()
            
            # Cancel the worker task and wait for it
            worker_task.cancel()
            try:
                await asyncio.wait_for(worker_task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                logger.info("Worker task cancelled")
        
    except asyncio.CancelledError:
        logger.info("Worker cancelled, shutting down...")
        try:
            await asyncio.wait_for(worker.shutdown(), timeout=3.0)
        except asyncio.TimeoutError:
            logger.warning("Shutdown timed out, forcing exit...")
    except SystemExit:
        logger.info("Force exit requested")
    except Exception as e:
        logger.error(f"Worker error: {str(e)}", exc_info=True)
        set_worker_status(False)
        raise
    finally:
        set_worker_status(False)
        logger.info("Worker stopped")


if __name__ == "__main__":
    asyncio.run(main())

