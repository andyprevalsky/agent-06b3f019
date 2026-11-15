"""The /proc scan population for suites whose fixtures are real same-user processes.

quiet(), namespace_quiet() and scan_same_user_processes() inspect every same-user process and
re-observe (or refuse) any they cannot read; that is the real safety check. Unrelated host processes
(a sibling suite's non-dumpable fixture, an exiting runner helper, a runner's (sd-pam)) are outside
every fixture, so a suite scans only its own process tree: patch
deploy_test_process.process_entries with own_process_entries. Cases:
2026-11-07-structural-suites-park-and-scan-unreadable-processes-concurrently (deploy-test-cycle,
then deploy-test-plan InterruptedProcessObservation).
"""
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import sys


def own_process_entries():
    """This test process and its descendants: the only processes a test here can create or own."""
    children = {}
    for process in Path('/proc').iterdir():
        try:
            parent = int((process / 'stat').read_text().rsplit(') ', 1)[1].split()[1]) if process.name.isdigit() else None
        except (FileNotFoundError, ProcessLookupError):
            continue  # exited mid-scan
        if parent is not None:
            children.setdefault(parent, []).append(int(process.name))
    owned, frontier = [], [os.getpid()]
    while frontier:
        pid = frontier.pop()
        owned.append(Path('/proc', str(pid)))
        frontier.extend(children.get(pid, ()))
    return iter(owned)


@contextmanager
def unrelated_unreadable_process():
    """A same-user non-dumpable process outside this test's tree, like the runner's pid 211414 (PR #1762)."""
    grandchild = ("import ctypes,os,sys;ctypes.CDLL(None).prctl(4,0,0,0,0);"
                  "print(os.getpid(),flush=True);sys.stdin.read()")
    launcher = subprocess.Popen([sys.executable, '-c', 'import subprocess,sys;subprocess.Popen('
                                 f'[sys.executable,"-c",{grandchild!r}],start_new_session=True)'],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        pid = int(launcher.stdout.readline())
        launcher.wait(timeout=10)  # the re-parented grandchild leaves this process tree
        yield pid
    finally:
        launcher.stdin.close()  # EOF ends the grandchild; nothing is signalled
        launcher.stdout.close()
        launcher.wait(timeout=10)
