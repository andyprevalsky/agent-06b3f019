"""Temporal worker for Navi autonomous agents."""

import asyncio
import signal
import sys
import os
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
from tools import (
    send_sms,
    list_contacts,
    web_search,
    accomplish_web_task,
)
# Helper activities (workflow orchestration, not exposed to LLM)
from helpers import (
    poll_new_messages,
    post_agent_message,
    call_llm,
    decide_next_action,
    check_progress,
    update_agent_status,
    compress_context,
    get_model_context_window,
    fetch_agent_tools,
    query_blueprints,
    save_blueprint,
    mark_finished,
    fetch_agent_config,
)
from health_server import run_health_server, set_worker_status

# Configure structured logging
structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.processors.JSONRenderer()
    ]
)

logger = structlog.get_logger()


async def main():
    """Main worker entry point."""
    
    # Load configuration
    config = load_config()
    
    # Start health check server
    health_thread = run_health_server(config.health_check_port)
    set_worker_status(True)
    
    logger.info(
        "Starting Temporal worker",
        namespace=config.temporal.namespace,
        task_queue=config.temporal.task_queue
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
    )
    
    # Create worker with all workflows and activities
    worker = Worker(
        client,
        task_queue=config.temporal.task_queue,
        workflows=[
            AgentWorkflow
        ],
        activities=[
            send_sms,
            list_contacts,
            web_search,
            accomplish_web_task,
            poll_new_messages,
            post_agent_message,
            call_llm,
            decide_next_action,
            check_progress,
            update_agent_status,
            compress_context,
            get_model_context_window,
            fetch_agent_tools,
            query_blueprints,
            save_blueprint,
            mark_finished,
            fetch_agent_config
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
    
    def handle_shutdown():
        logger.info("Shutdown signal received, initiating graceful shutdown...")
        shutdown_event.set()
    
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
        
        # If shutdown was signaled, shutdown worker cleanly
        if shutdown_task in done:
            logger.info("Stopping worker task...")
            await worker.shutdown()
            logger.info("Worker shutdown complete, cancelling worker task...")
            
            # Cancel the worker task and wait for it
            worker_task.cancel()
            try:
                await worker_task
            except asyncio.CancelledError:
                logger.info("Worker task cancelled successfully")
        
    except asyncio.CancelledError:
        logger.info("Worker cancelled, shutting down...")
        await worker.shutdown()
    except Exception as e:
        logger.error(f"Worker error: {str(e)}", exc_info=True)
        set_worker_status(False)
        raise
    finally:
        set_worker_status(False)
        logger.info("Worker stopped gracefully")


if __name__ == "__main__":
    asyncio.run(main())

