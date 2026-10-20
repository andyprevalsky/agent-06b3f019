---
name: change-environment-size
description: Use when real work needs more or less CPU or memory (repeated OOM kills, heavy swap, slow CPU-bound builds or tests). Not for runaway processes.
---

# Changing your environment size

Your sandbox has a fixed number of vCPUs and a fixed amount of memory. When the
work itself needs more, move this session to a larger sandbox; when the heavy
phase is over, move it back to a smaller one. CPU and memory change
independently.

## When to use

- Processes are killed for lack of memory again and again (`OOM kills` rises in
  `rose env status`, or builds and tests die with `Killed` or exit 137).
- The sandbox swaps heavily and the work slows to a crawl.
- A build or test suite stays CPU-bound for minutes (load average at or above
  the vCPU count) and more vCPUs would finish it sooner.
- The heavy phase is over: downsize so the session does not hold resources it
  no longer needs.

## When not to use

A bigger sandbox does not fix a bug. Do not resize for:

- a runaway or stuck process, an infinite loop or a fork bomb: kill it;
- a memory leak or a process that keeps growing: fix it or restart it;
- caches, build outputs or stale dev servers you can clean up: free them first.

If one process you did not expect is at the top of `rose env status`, deal with
that process instead of resizing.

## How

1. Look first: `rose env status` shows the current size, the largest size you
   may use, memory and swap use, load average, OOM kills, and the top 5
   processes by memory and by CPU.
2. Ask for what you need, with a reason that cites what you saw:
   `rose env size --memory-gb 16 --reason "jest workers OOM-killed 3 times at 4 GB"`
   or `rose env size --cpu 8 --reason "tsc + vitest CPU-bound for 6 min on 2 vCPU"`.
   Give `--cpu`, `--memory-gb` or both; a dimension you leave out stays as it is.
   You get the closest available size that satisfies the request. The same
   tool is on the `rose` MCP server as `change_environment_size`.
3. Wrap up the current step and do not start new heavy work. Within about two
   minutes the session is saved and continues automatically in the new
   sandbox: same branch, commits, uncommitted files and conversation. You get
   a message stating the new size. Running processes (dev servers, watchers)
   do not survive the move; start again the ones you need. Installed
   dependencies outside the repository may need reinstalling.
4. When the heavy phase ends, downsize the same way.

Resizes are limited: each dimension changes at most once per cooldown, moving a
dimension straight back is refused for a while, and sizes above your account's
limit are refused. A refused request says why; do not retry it in a loop.
