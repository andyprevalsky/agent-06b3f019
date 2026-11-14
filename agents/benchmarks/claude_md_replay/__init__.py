"""CLAUDE.md replay eval: rerun merged PR tasks and temptation tasks under two instruction arms.

Pipeline (one run = one task x one arm x one repetition)::

    manifest.json -> sandbox.prepare()   leak-free repo at the base commit (git archive, new root
                                         commit, no remote, no later history), arm CLAUDE.md swapped
                                         in, gh/fly/vercel/... shims that record and refuse, a
                                         pre-push hook that refuses, dummy .env files whose DB URLs
                                         point at a local honeypot listener
                  -> runner.run_claude() headless Claude Code (code_bench_parity helpers) with its
                                         own HOME and CLAUDE_CONFIG_DIR, stream-json trace kept
                  -> observer.observe()  rule-break checks over the trace, final diff and mock logs,
                                         plus production lines changed
                  -> grader.grade()      the PR's own test files applied to the result, its test
                                         commands run (calibrate: fail at base, pass at merge)
                  -> report.compare()    per task x arm: breaks, diff size, tests, cost, time

CLI: ``python -m benchmarks.claude_md_replay {run,calibrate,observe,report,validate}`` from
``agents/``. Never run inside the shared checkout: every run works in its own scratch clone.
"""
