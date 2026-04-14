"""E2B Sandbox Log Collector.

Collects logs from E2B sandboxes using the CLI and pipes them to structlog.
This provides visibility into what's happening inside the sandbox for debugging.
"""

import asyncio
import contextlib
from typing import Optional

import structlog

logger = structlog.get_logger()


class SandboxLogCollector:
    """
    Collects E2B sandbox logs via CLI and pipes to structlog.

    Usage:
        collector = SandboxLogCollector(sandbox_id, agent_id)
        await collector.start()
        # ... do work ...
        await collector.stop()
    """

    def __init__(self, sandbox_id: str, agent_id: str, task_id: str):
        self.sandbox_id = sandbox_id
        self.agent_id = agent_id
        self.task_id = task_id
        self.process: Optional[asyncio.subprocess.Process] = None
        self._reader_task: Optional[asyncio.Task] = None
        self._stopped = False

    async def start(self) -> bool:
        """
        Start collecting sandbox logs in background.

        Returns True if started successfully, False otherwise.
        """
        try:
            # Start e2b CLI to stream logs
            # --level DEBUG captures all log levels
            # --loggers covers: process, filesystem, terminal, network
            self.process = await asyncio.create_subprocess_exec(
                "e2b",
                "sandbox",
                "logs",
                self.sandbox_id,
                "-f",  # Follow/stream logs
                "--level",
                "DEBUG",
                "--loggers",
                "process,filesystem,terminal,network",
                "--format",
                "pretty",  # Human readable
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,  # Merge stderr into stdout
            )

            # Start background task to read and log output
            self._reader_task = asyncio.create_task(self._read_logs())

            logger.info(
                "[E2B:Logs] Started sandbox log collector",
                sandbox_id=self.sandbox_id,
                agent_id=self.agent_id,
                task_id=self.task_id,
            )
            return True

        except FileNotFoundError:
            logger.warning(
                "[E2B:Logs] e2b CLI not found - sandbox logs disabled",
                sandbox_id=self.sandbox_id,
                agent_id=self.agent_id,
            )
            return False
        except Exception as e:
            logger.warning(
                "[E2B:Logs] Failed to start log collector",
                sandbox_id=self.sandbox_id,
                agent_id=self.agent_id,
                error=str(e),
            )
            return False

    async def _read_logs(self):
        """Background task to read log lines and pipe to structlog."""
        if not self.process or not self.process.stdout:
            return

        try:
            while not self._stopped:
                line = await self.process.stdout.readline()
                if not line:
                    # EOF - process ended
                    break

                # Decode and strip the line
                log_line = line.decode("utf-8", errors="replace").rstrip()
                if log_line:
                    # Log with E2B:Sandbox prefix for easy filtering
                    logger.info(
                        f"[E2B:Sandbox] {log_line}",
                        sandbox_id=self.sandbox_id,
                    )

        except asyncio.CancelledError:
            pass
        except Exception as e:
            if not self._stopped:
                logger.warning(
                    "[E2B:Logs] Log reader error",
                    sandbox_id=self.sandbox_id,
                    error=str(e),
                )

    async def stop(self):
        """Stop log collection and cleanup."""
        self._stopped = True

        # Cancel reader task
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reader_task

        # Terminate the e2b CLI process
        if self.process:
            try:
                self.process.terminate()
                # Wait briefly for graceful shutdown
                await asyncio.wait_for(self.process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                # Force kill if it doesn't terminate
                self.process.kill()
                await self.process.wait()
            except Exception:
                pass

        logger.info(
            "[E2B:Logs] Stopped sandbox log collector",
            sandbox_id=self.sandbox_id,
            agent_id=self.agent_id,
            task_id=self.task_id,
        )
