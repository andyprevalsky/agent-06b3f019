"""External benchmark execution fixture with the real uploader and guest ACK owner."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('group_upload', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
from benchmarks import outcome_publication as publication

work = Path(os.environ['GROUP_CONTROL_WORK'])
job = os.environ['RUN_BENCH_CAMPAIGN_JOB_ID']
group = os.environ['RUN_BENCH_CAMPAIGN_ID']
run = 'owned-' + group + '-' + job
name = os.environ['RUN_BENCH_CAMPAIGN_TASK']
agent = '00000000-0000-4000-8000-' + ('1' if job.endswith('0001') else '2').zfill(12)
os.environ.update(BENCHMARK_HUB_PARENT_RUN_ID=run, FLY_MACHINE_ID='a' * 14, CLOUDBENCH_BARRIER_TOKEN='fixture-bearer')
guest = work / job / 'guest'
context = guest / 'repo/.context/cloudbench'
context.mkdir(parents=True)
result = SimpleNamespace(name=name, passed=True, agent_id=agent)
prepared = publication.prepare(result, context, 'fixture-' + job)
assert prepared is not None
ack, signature = prepared
ready = work / job / 'server.port'
server = subprocess.Popen([sys.executable, str(Path(os.environ['GROUP_PROJECT_ROOT']) / 'scripts/cloudbench-status-server.py'), '--directory', str(guest), '--bind', '127.0.0.1', '--port', '0', '--run-token', 'fixture-' + job, '--ready-file', str(ready)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    deadline = time.monotonic() + 20
    while not ready.exists():
        assert server.poll() is None and time.monotonic() < deadline
        time.sleep(0.02)
    out = work / job / name
    out.mkdir()
    (out / 'runtime-evidence.owner.json').write_text(json.dumps({'run_token': 'fixture-' + job, 'machine_id': 'a' * 14}))
    (out / 'status-proxy.port').write_text(ready.read_text())
    body = {'run_id': run, 'timestamp': os.environ.get('RUN_BENCH_CAMPAIGN_STARTED_AT', '2026-10-06T20:00:00+00:00'), 'tasks': [{'name': name, 'passed': None, 'status': 'queued', 'agent_id': agent}]}
    module.require_run_visible(body)
    body['tasks'][0].update(passed=True, status='passed', tokens_in=7, tokens_out=3)
    assert module.upload_run_bundle(body, live=True, required=True, verify_live_response=True)
    assert not ack.exists()
    card = {'per_task': [{'name': name, 'status': 'passed', 'agent_url': 'https://www.roselabs.ai/?agent-id=' + agent, 'outcome_sha256': signature}]}
    publication.acknowledge_published(card, run_id=run, fleet_dir=work / job)
    assert ack.read_text().strip() == signature
    asyncio.run(publication.wait_for_publication(prepared))
    (work / ('evaluated-' + job)).write_text(run)
    while not (work / 'release').exists():
        time.sleep(0.02)
    assert module.upload_run_bundle(body, live=False, required=True)
    assert (out / 'hub-outcome-published.ack').read_text().strip() == signature
    (work / ('terminal-' + job)).write_text(run)
finally:
    server.terminate()
    server.wait(timeout=20)
    assert server.poll() is not None
