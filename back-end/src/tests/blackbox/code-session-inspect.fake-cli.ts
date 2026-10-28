/**
 * Scripted CLIs for code-session-inspect.blackbox.ts. claude reads the question on stdin; codex gets it as the last
 * argument and writes its answer to --output-last-message. Each run records
 * what it saw (argv, cwd, env, guard results) to cli-runs.jsonl.
 */
export function fakeInspectCli(paths: {
  cliLog: string;
  modeFile: string;
  realGit: string;
}): string {
  return String.raw`#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
CLI = os.path.basename(sys.argv[0])
LOG = pathlib.Path(${JSON.stringify(paths.cliLog)})
MODE = pathlib.Path(${JSON.stringify(paths.modeFile)})
REAL_GIT = ${JSON.stringify(paths.realGit)}
mode = MODE.read_text().strip() if MODE.exists() else "answer"
argv = sys.argv[1:]
if CLI == "codex" and argv[:1] == ["login"]:
    sys.stdin.read()
    sys.exit(0)
prompt = sys.stdin.read() if CLI == "claude" else argv[-1]

def run(cmd):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return {"cmd": cmd, "rc": p.returncode, "out": p.stdout.strip()[-300:], "err": p.stderr.strip()[-300:]}

record = {"cli": CLI, "argv": argv, "cwd": os.getcwd(), "prompt": prompt, "mode": mode,
          "path0": os.environ.get("PATH", "").split(":")[0],
          "anthropic_key": os.environ.get("ANTHROPIC_API_KEY", ""), "openai_key": bool(os.environ.get("OPENAI_API_KEY")), "azure_key": os.environ.get("AZURE_OPENAI_API_KEY", ""),
          "github_token": bool(os.environ.get("GITHUB_TOKEN")),
          "env_file_left": (pathlib.Path(os.environ["HOME"]) / ".rose-inspect" / "env").exists(),
          "home_claude_md": (pathlib.Path(os.environ["HOME"]) / "CLAUDE.md").exists()}
if CLI == "claude" and mode == "rate_limit":
    print(json.dumps({"type": "system", "subtype": "init"}))
    print(json.dumps({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": 1790988600}}))
    print(json.dumps({"type": "result", "subtype": "error_during_execution", "is_error": True, "result": "limit"}))
    LOG.open("a").write(json.dumps(record) + "\n")
    sys.exit(1)
if mode == "crash":
    LOG.open("a").write(json.dumps(record) + "\n")
    sys.stderr.write("boom\n")
    sys.exit(2)
if mode == "slow":
    import time
    LOG.open("a").write(json.dumps(record) + "\n")
    time.sleep(3)
    record["slow_done_ms"] = int(time.time() * 1000)
    LOG.open("a").write(json.dumps(record) + "\n")
    sys.exit(0)
head_before = run("git rev-parse HEAD")["out"]
record["attempts"] = {
    "read": run("git log -1 --format=%s"),
    "commit": run("git commit -am 'inspector commit'"),
    "push": run("git push origin HEAD"),
    "merge": run("git -C . merge main"),
    "direct_commit": run(REAL_GIT + " commit --allow-empty -m 'direct commit'"),
    "gh": run("gh pr create --fill"),
}
record["head_before"] = head_before
record["head_after"] = run("git rev-parse HEAD")["out"]
record["remote"] = run("git remote get-url origin")["out"]
pathlib.Path("inspector-scratch.txt").write_text("scratch\n")
feature = pathlib.Path("feature.txt").read_text().strip()
LOG.open("a").write(json.dumps(record) + "\n")
answer = ("feature.txt holds: " + feature + "\n\nCitations:\n- feature.txt:1\n- README.md:1-2\n"
          "- missing/nowhere.ts:9\n- ../escape.txt:1\n")
if CLI == "codex":
    out = argv[argv.index("--output-last-message") + 1]
    pathlib.Path(out).write_text(answer)
    print(json.dumps({"type": "thread.started", "thread_id": "t-1"}))
    print(json.dumps({"type": "turn.completed", "usage": {}}))
else:
    print(json.dumps({"type": "system", "subtype": "init"}))
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": answer}))
`;
}
