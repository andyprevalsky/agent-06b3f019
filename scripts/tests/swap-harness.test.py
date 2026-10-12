#!/usr/bin/env python3
"""Offline behavioral checks for the swap-harness skill's managed helpers."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / ".agents/skills/swap-harness"


class SwapHarnessHelpers(unittest.TestCase):
    def test_inventory_pages_empty_results_and_keeps_transcripts_private(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            fake = work / "dvb-onbox"
            fake.write_text("""#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['SWAP_CALLS'], 'a') as out: out.write(json.dumps(args)+'\\n')
thread = {'id':'internal', 'publicId':'thr_original', 'archived':False, 'agent':'claude'}
if args[1] == 'read':
    result = {'ok':True, 'transcript':{'messages':[{'role':'assistant','text':'Actual task context'}]}}
elif '--cursor' not in args:
    result = {'ok':True, 'threads':[], 'pagination':{'complete':False,'nextCursor':'empty-page'}}
elif args[args.index('--cursor')+1] == 'empty-page':
    result = {'ok':True, 'threads':[thread], 'pagination':{'complete':False,'nextCursor':'last'}}
else:
    result = {'ok':True, 'threads':[thread], 'pagination':{'complete':True,'nextCursor':None}}
print(json.dumps(result))
""")
            fake.chmod(0o700)
            calls = work / "calls.jsonl"
            env = dict(os.environ, PATH=f"{work}{os.pathsep}{os.environ['PATH']}", SWAP_CALLS=str(calls))
            output = work / "private.json"
            output.write_text("old content")
            output.chmod(0o644)
            targets = work / "targets.json"
            targets.write_text(json.dumps({"thr_original": "actual-devbox"}))
            result = subprocess.run(
                [sys.executable, str(SKILL / "scripts/inventory.py"), "--output", str(output), "--targets-file", str(targets)],
                env=env, capture_output=True, text=True, check=True,
            )
            payload = json.loads(output.read_text())
            self.assertTrue(payload["complete"])
            self.assertEqual(len(payload["threads"]), 1)
            self.assertEqual(payload["threads"][0]["devboxId"], "actual-devbox")
            self.assertEqual(payload["threads"][0]["transcript"]["messages"][0]["text"], "Actual task context")
            self.assertNotIn("Actual task context", result.stdout)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            invoked = [json.loads(line) for line in calls.read_text().splitlines()]
            self.assertEqual(len(invoked), 4)
            self.assertEqual(invoked[-1][1], "read")

    def test_incomplete_inventory_does_not_publish_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            fake = work / "dvb-onbox"
            fake.write_text('#!/bin/sh\necho \'{"ok":true,"threads":[],"pagination":{"complete":false,"nextCursor":"same"}}\'\n')
            fake.chmod(0o700)
            output = work / "inventory.json"
            result = subprocess.run(
                [sys.executable, str(SKILL / "scripts/inventory.py"), "--output", str(output)],
                env=dict(os.environ, PATH=f"{work}{os.pathsep}{os.environ['PATH']}"), capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())

    def test_both_harnesses_receive_same_skill_and_repeat_install_is_safe(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            command = [sys.executable, str(SKILL / "scripts/install.py"), "--home", str(home)]
            for _ in range(2):
                subprocess.run(command, check=True, capture_output=True)
            codex = home / ".agents/skills/swap-harness"
            claude = home / ".claude/skills/swap-harness"
            self.assertEqual(codex.resolve(), claude.resolve())
            self.assertEqual((codex / "SKILL.md").read_bytes(), (SKILL / "SKILL.md").read_bytes())
            subprocess.run([sys.executable, str(claude / "scripts/inventory.py"), "--help"], check=True, capture_output=True)
            self.assertEqual((ROOT / ".claude/skills/swap-harness").resolve(), SKILL.resolve())

    def test_install_conflict_leaves_existing_skill_and_other_destination_intact(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            original = home / ".claude/skills/swap-harness"
            original.mkdir(parents=True)
            (original / "SKILL.md").write_text("existing local skill")
            result = subprocess.run(
                [sys.executable, str(SKILL / "scripts/install.py"), "--home", str(home)], capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((original / "SKILL.md").read_text(), "existing local skill")
            self.assertFalse((home / ".agents/skills/swap-harness").exists())
            self.assertFalse((home / ".local/share/boxes-skills/swap-harness").exists())


if __name__ == "__main__":
    unittest.main()
