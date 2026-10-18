#!/usr/bin/env python3
"""Offline bound status inputs and actual exact-path guest status projection."""
import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
M=runpy.run_path(os.environ.get('CLOUDBENCH_TEST_ORIGINAL600_STATUS_MODULE',str(ROOT/'scripts/original600-status.py')))


def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value));path.chmod(0o600)
    return path


class Status(unittest.TestCase):
    def test_disabled_stop_policy_preserves_threshold_and_failure_accounting(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "status.py"
            source.write_text(M["REMOTE"])
            scope = runpy.run_path(str(source))
        jobs = [dict(job_id=str(i), task="fixture", status="failed" if i < 31 else "running", attempts=[dict(attempt=1, status="failed", finished_at=1, infra_failure=True)] if i < 31 else []) for i in range(600)]
        summary = dict(total_jobs=600, jobs=jobs)
        startup = dict(proofs=[dict(job_id="32")], unavailable_jobs=0, inspected_logs=1, bytes_read=0)
        default = scope["project"](summary, startup)
        disabled = scope["project"](summary, startup, "disabled")
        self.assertTrue(default["infra_stop_required"])
        self.assertFalse(disabled["infra_stop_required"])
        self.assertTrue(disabled["infra_threshold_breached"])
        self.assertEqual(disabled["combined_infra_affected_jobs"], 32)
        self.assertEqual({k: v for k, v in default.items() if k not in ("infra_early_stop", "infra_stop_required")}, {k: v for k, v in disabled.items() if k not in ("infra_early_stop", "infra_stop_required")})
        with self.assertRaises(ValueError):
            scope["project"](summary, startup, "unknown")

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.root.chmod(0o700)
        self.run=self.root/'operator/run';self.run.mkdir(parents=True,mode=0o700)
        self.ref='a'*40;self.mid='1234567890abcd';self.epoch=100.5
        self.env=self.root/'complete-agents.env';self.env.write_text('COMPLETE=fixture\nFLY_API_TOKEN=FlyV1 fixture\n');self.env.chmod(0o600)
        self.cfg=write(self.run.parent/'config.private.json',dict(schema='original600-controller-runner-v1',allowed=True,
            source_ref=self.ref,source_root=str(self.root),started_at_epoch=self.epoch,source_files={}))
        self.auth=write(self.run/'authority.private.json',dict(source_ref=self.ref,app='navi-whisper-lux-bench',
            output_directory=str(self.run/'export'),protected_machines=['00000000000000'],
            env_files=dict(agents=dict(path=str(self.env),sha256=M['digest'](self.env.read_bytes())))))
        write(self.run/'controller.identity.json',dict(machine=self.mid,instance='instance-fixture',source_ref=self.ref,
              authority_sha256=M['digest'](self.auth.read_bytes())))
        write(self.run/'export/disposable-controller.ownership.json',dict(schema='cloudbench-disposable-controller-ownership-v1',
              authority_sha256=M['digest'](self.auth.read_bytes()),machine=dict(id=self.mid,instance_id='instance-fixture')))
        self.caller=write(self.run/'caller.json',dict(source_ref=self.ref,authority_sha256=M['digest'](self.auth.read_bytes()),
            epoch=self.epoch,identity_path='/tmp/gate/repo/.context/original600-supervisor.fixture.json'))

    def test_bound_explicit_complete_env_works_without_checkout_dotenv_and_refuses_drift(self):
        value=M['binding'](self.run)
        self.assertEqual(value['agents_env'],self.env)
        self.assertFalse((self.root/'agents/.env').exists())
        identity_path=self.run/'controller.identity.json';identity=json.loads(identity_path.read_text())
        write(identity_path,dict(identity,machine='ffffffffffffff'))
        with self.assertRaisesRegex(ValueError,'sealed controller'):M['binding'](self.run)
        write(identity_path,dict(identity,authority_sha256='0'*64))
        with self.assertRaisesRegex(ValueError,'sealed authority changed'):M['binding'](self.run)
        write(identity_path,identity)
        self.assertEqual(M['binding'](self.run,agents_env=self.env)['credential_sha256'],M['digest'](self.env.read_bytes()))
        wrong=self.root/'other.env';wrong.write_text('FLY_API_TOKEN=other\n');wrong.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'complete agents input changed'):M['binding'](self.run,agents_env=wrong)
        caller=json.loads(self.caller.read_text());caller['epoch']+=1;write(self.caller,caller)
        with self.assertRaisesRegex(ValueError,'epoch mismatch'):M['binding'](self.run)
        # The reader uses target-ref Git bytes, not whatever helper happens to
        # be on the monitor checkout's PATH or in a different source tree.
        (self.root/'scripts').mkdir()
        for name in ['run-original600-controller.py','cloudbench-original-volume-capture.py']:
            (self.root/'scripts'/name).write_bytes((ROOT/'scripts'/name).read_bytes())
        subprocess.run(['git','init','-q',str(self.root)],check=True)
        subprocess.run(['git','-C',str(self.root),'add','scripts'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=fixture','-c','user.email=fixture@example.test',
                        '-c','commit.gpgsign=false','commit','-qm','source fixture'],check=True)
        ref=subprocess.check_output(['git','-C',str(self.root),'rev-parse','HEAD'],text=True).strip()
        source=self.root/'scripts/run-original600-controller.py';expected=M['digest'](source.read_bytes())
        parser=M['bound_source'](self.root,ref,source.name,expected)
        self.assertEqual(parser['token_from_agents'](self.env.read_bytes()),'FlyV1 fixture')
        native=self.root/'scripts/cloudbench-original-volume-capture.py'
        self.assertIn('Fly',M['bound_source'](self.root,ref,native.name,M['digest'](native.read_bytes())))
        source.write_bytes(source.read_bytes()+b'\n# changed after binding\n')
        with self.assertRaisesRegex(ValueError,'source bytes changed'):
            M['bound_source'](self.root,ref,source.name,expected)


    def test_status_policy_is_bound_to_config_and_guest_supervisor_identity(self):
        cfg = json.loads(self.cfg.read_bytes())
        write(self.cfg, dict(cfg, infra_early_stop="disabled"))
        value = M["binding"](self.run)
        self.assertEqual(value["payload"]["infra_early_stop"], "disabled")
        self.assertEqual(value["payload"]["epoch"], self.epoch)
        write(self.cfg, dict(cfg, infra_early_stop="unknown"))
        with self.assertRaisesRegex(ValueError, "early-stop policy"):
            M["binding"](self.run)

    def test_continuation_status_verifies_original_config_and_successor_chain(self):
        original=json.loads(self.cfg.read_bytes())
        original['authority_template']=str(self.root/'old-authority')
        write(self.cfg,original)
        original_sha=M['digest'](self.cfg.read_bytes())
        write(self.run.parent/'attempt-start.safe.json',dict(source_ref=self.ref,config_sha256=original_sha))
        previous=self.run.parent/'previous-run';previous.mkdir(mode=0o700)
        failure=dict(path=str(self.root/'positive-failure'),sha256='e'*64,
                     prior_output=str(previous),successor_output=str(self.run))
        provenance=dict(original_config_path=str(self.cfg),original_config_sha256=original_sha,
                        original_started_at_epoch=self.epoch,workload_source_ref=self.ref,
                        host_operator_source_ref='b'*40,host_runner_sha256='c'*64,prelaunch_failure=failure)
        config=write(self.root/'continuation/config.private.json',dict(original,
                     authority_template=str(self.root/'new-authority'),host_operator_provenance=provenance))
        write(self.run/'host-operator-provenance.json',provenance)
        pointer=write(previous/'host-launch-successor.json',dict(schema='original600-host-launch-successor-v1',
                     evidence=failure,config_path=str(config),config_sha256=M['digest'](config.read_bytes()),
                     original_started_at_epoch=self.epoch,host_operator_source_ref='b'*40))
        value=M['binding'](self.run,config)
        self.assertEqual(value['mode'],'REMOTE')
        self.assertEqual(value['payload']['epoch'],self.epoch)
        self.assertEqual(value['source_ref'],self.ref)
        before=config.read_bytes()
        write(config,dict(json.loads(before),remote_env={'changed':'task-input'}))
        with self.assertRaises(ValueError):M['binding'](self.run,config)
        config.write_bytes(before)
        saved=pointer.read_bytes();write(pointer,dict(json.loads(saved),config_sha256='0'*64))
        with self.assertRaises(ValueError):M['binding'](self.run,config)
        pointer.write_bytes(saved)
        write(self.run/'host-operator-provenance.json',dict(provenance,original_started_at_epoch=self.epoch+1))
        with self.assertRaises(ValueError):M['binding'](self.run,config)

    def test_actual_guest_exact_path_projection_preserves_unknown_and_unique_infra(self):
        repo=self.root/'guest';repo.mkdir()
        subprocess.run(['git','init','-q',str(repo)],check=True)
        (repo/'source').write_text('fixture')
        subprocess.run(['git','-C',str(repo),'add','source'],check=True)
        subprocess.run(['git','-C',str(repo),'-c','user.name=fixture','-c','user.email=fixture@example.test',
                        '-c','commit.gpgsign=false','commit','-qm','fixture'],check=True)
        ref=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
        scope={'__name__':'offline_status_payload'};exec(M['REMOTE'],scope)
        payload=dict(machine=self.mid,source_ref=ref,epoch=self.epoch,
                     identity_path='/tmp/gate/repo/.context/original600-supervisor.fixture.json')
        with patch.dict(os.environ,FLY_MACHINE_ID=self.mid):
            self.assertEqual(scope['guest_status'](payload,repo,'boot-fixture')['status'],'SUPERVISOR_NOT_PUBLISHED')
            write(repo/'.context/original600-supervisor.fixture.json',dict(schema='original600-supervisor-identity-v1',
                  machine=self.mid,source_ref=ref,epoch=self.epoch,pid=812))
            self.assertEqual(scope['guest_status'](payload,repo,'boot-fixture')['status'],'SUMMARY_NOT_PUBLISHED')
            ns=hashlib.sha256((float(self.epoch).hex()+':boot-fixture').encode()).hexdigest()[:24]
            path=repo/'.context/benchmarks/campaigns'/('campaign-qualified600-'+ns+'-812')/'summary.json'
            summary=dict(total_jobs=600,campaign_id=path.parent.name,e2e_started_at_epoch=self.epoch,jobs=[dict(job_id='one',status='failed',attempts=[
                dict(status='failed',finished_at='original-time',infra_failure=True),
                dict(status='failed',finished_at='retry-time',infra_failure=True)]),
                dict(job_id='two',status='failed',attempts=[]),dict(job_id='three',status='running',attempts=[]),
                dict(job_id='four',status='failed',attempts=[dict(status='failed',finished_at='original-time',infra_failure=None)])]
                +[dict(job_id='queued-'+str(i),status='queued',attempts=[]) for i in range(596)])
            write(path,summary)
            # A nearby unrelated campaign must never be scanned/read.
            write(repo/'.context/benchmarks/campaigns/campaign-unrelated/summary.json',dict(jobs=[dict(secret='unrelated')]))
            result=scope['guest_status'](payload,repo,'boot-fixture')
            self.assertEqual(result['status'],'SUMMARY')
            counts=result['summary'];self.assertEqual(counts['canonical_infra_affected_jobs'],1)
            self.assertEqual(counts['failed_jobs_without_terminal_attempt'],1)
            self.assertEqual(counts['attempt_records'],3);self.assertEqual(counts['terminal_attempts'],3)
            self.assertEqual(counts['jobs_with_unknown_terminal_infra'],1)
            self.assertEqual(counts['terminal_attempt_records_with_unknown_infra'],1)
            self.assertFalse(counts['benchmark_success_inferred'])
            identity_file = repo / '.context/original600-supervisor.fixture.json'
            original_identity = json.loads(identity_file.read_bytes())
            write(identity_file, dict(original_identity, infra_early_stop='disabled'))
            with self.assertRaisesRegex(ValueError, 'early-stop policy mismatch'):
                scope['guest_status'](payload, repo, 'boot-fixture')
            disabled = scope['guest_status'](dict(payload, infra_early_stop='disabled'), repo, 'boot-fixture')
            self.assertEqual(disabled['summary']['infra_early_stop'], 'disabled')
            self.assertFalse(disabled['summary']['infra_stop_required'])
            write(identity_file, original_identity)
            for changed in [dict(campaign_id='unrelated'),dict(e2e_started_at_epoch=self.epoch+1),dict(total_jobs=599)]:
                write(path,dict(summary,**changed))
                with self.assertRaises(ValueError):scope['guest_status'](payload,repo,'boot-fixture')
            write(path,summary)
            # A bound shard reads its own job count and exact group-wide IDs from the payload.
            shard_jobs=[dict(job_id='r%03d-j%04d'%(r,(r-1)*200+i+1),status='queued',attempts=[]) for r in (1,2,3) for i in (0,7,9)]
            write(path,dict(summary,total_jobs=9,jobs=shard_jobs))
            sharded=dict(payload,total_jobs=9,campaign_total_jobs=600,infra_stop_threshold=30,task_indexes=[0,7,9],runs=3)
            self.assertEqual(scope['guest_status'](sharded,repo,'boot-fixture')['summary']['observed_jobs'],9)
            for wrong in (payload,dict(sharded,task_indexes=[0,7,8]),dict(sharded,campaign_total_jobs=300)):
                with self.assertRaises(ValueError):scope['guest_status'](wrong,repo,'boot-fixture')
            write(path,summary)
            with self.assertRaises(ValueError):scope['guest_status'](dict(payload,identity_path='/private/arbitrary.json'),repo,'boot-fixture')
            with self.assertRaises(ValueError):scope['guest_status'](dict(payload,epoch=self.epoch+1),repo,'boot-fixture')

    def test_shard_totals_come_from_bound_config_not_fixed_600(self):
        cfg=json.loads(self.cfg.read_bytes())
        legacy=M['binding'](self.run)['payload']
        self.assertEqual(set(legacy),{'machine','source_ref','epoch','identity_path','infra_early_stop'})
        names=['task-a','task-b','task-c']
        shard=dict(index=0,count=20,tasks=names,tasks_sha256=M['digest'](('\n'.join(names)+'\n').encode()),task_indexes=[0,7,9],runs=3,
                   group_run_id='campaign-group-fixture',group_total=600,group_started_at=self.epoch)
        write(self.cfg,dict(cfg,shard=shard))
        payload=M['binding'](self.run)['payload']
        added=('total_jobs','campaign_total_jobs','infra_stop_threshold','task_indexes','runs')
        self.assertEqual({k:payload[k] for k in added},dict(total_jobs=9,campaign_total_jobs=600,infra_stop_threshold=30,task_indexes=[0,7,9],runs=3))
        self.assertEqual({k:v for k,v in payload.items() if k not in added},legacy)
        write(self.cfg,dict(cfg,shard=dict(shard,infra_threshold=2)))
        self.assertEqual(M['binding'](self.run)['payload']['infra_stop_threshold'],2)
        write(self.cfg,dict(cfg,shard=dict(shard,runs=0)))
        with self.assertRaises(ValueError):M['binding'](self.run)
        scope={'__name__':'offline_status_payload'};exec(M['REMOTE'],scope)
        jobs=[dict(job_id='r%03d-j%04d'%(1+i//3,(i//3)*200+[0,7,9][i%3]+1),task=names[i%3],status='failed' if i<2 else 'queued',
                   attempts=[dict(attempt=1,status='failed',finished_at=1,infra_failure=True)] if i<2 else []) for i in range(9)]
        summary=dict(total_jobs=9,jobs=jobs)
        counts=scope['project'](summary,None,'enabled',total=9,threshold=2)
        self.assertEqual((counts['observed_jobs'],counts['canonical_infra_affected_jobs'],counts['infra_stop_threshold'],counts['infra_stop_required']),(9,2,2,True))
        self.assertFalse(scope['project'](summary,None,'enabled',total=9)['infra_threshold_breached'])
        with self.assertRaises(ValueError):scope['project'](summary)
        with self.assertRaises(ValueError):scope['project'](dict(total_jobs=600,jobs=[dict(job_id=str(i),attempts=[]) for i in range(600)]),total=9)
        self.assertEqual(sorted(j['job_id'] for j in jobs)[:3],['r001-j0001','r001-j0008','r001-j0010'])
        ids=scope['shard_job_ids'](dict(payload,task_indexes=[0,7,9],runs=3,campaign_total_jobs=600))
        self.assertEqual(ids,{j['job_id'] for j in jobs});self.assertIsNone(scope['shard_job_ids'](legacy))
        self.assertEqual(scope['project'](summary,None,'enabled',total=9,threshold=2,job_ids=ids)['observed_jobs'],9)
        renamed=dict(summary,jobs=[dict(jobs[0],job_id='r001-j0002')]+jobs[1:])
        with self.assertRaisesRegex(ValueError,'shard canonical job identities'):scope['project'](renamed,None,'enabled',total=9,job_ids=ids)
        self.assertEqual(scope['project'](renamed,None,'enabled',total=9)['observed_jobs'],9)

    def test_cancelled_and_unfinished_exact_true_infra_count_without_terminal_credit(self):
        scope={'__name__':'offline_status_payload'};exec(M['REMOTE'],scope)
        jobs=[dict(job_id='cancelled',status='cancelled',attempts=[
            dict(status='cancelled',finished_at=None,infra_failure=True),
            dict(status='cancelled',finished_at='cancel-time',infra_failure=True)]),
            dict(job_id='unfinished',status='running',attempts=[dict(status='running',infra_failure=True)]),
            dict(job_id='not-bool',status='cancelled',attempts=[
                dict(status='cancelled',infra_failure=1),dict(status='cancelled',infra_failure='true')])]
        jobs += [dict(job_id='queued-'+str(i),status='queued',attempts=[]) for i in range(597)]
        result=scope['project'](dict(total_jobs=600,jobs=jobs))
        self.assertEqual(result['canonical_infra_affected_jobs'],2)
        self.assertEqual(result['attempt_records'],5)
        self.assertEqual(result['terminal_attempts'],0)
        self.assertEqual(result['terminal_attempt_records_with_unknown_infra'],0)
        self.assertEqual(result['jobs_with_unknown_terminal_infra'],0)
        self.assertEqual(result['job_statuses'],dict(cancelled=2,running=1,queued=597))
        self.assertFalse(result['benchmark_success_inferred'])

    def test_actual_remote_entrypoint_decodes_payload_and_reports_guest_mismatch(self):
        payload=dict(machine=self.mid,source_ref=self.ref,epoch=self.epoch,
                     identity_path='/tmp/gate/repo/.context/original600-supervisor.fixture.json')
        # Execute the exact production -S/-c body, including __main__. A wrong
        # guest identity returns UNKNOWN before Git or any other external call.
        import shlex
        result=subprocess.run(shlex.split(M['status_command'](payload)),
                              env=dict(os.environ,FLY_MACHINE_ID='ffffffffffffff'),
                              capture_output=True,text=True,timeout=3)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stderr,'')
        value=json.loads(result.stdout)
        self.assertEqual(value['status'],'UNKNOWN')
        self.assertEqual(value['error'],'ValueError')
        self.assertEqual(value['machine'],self.mid)
        self.assertEqual(value['source_ref'],self.ref)
        self.assertEqual(value['original_epoch'],self.epoch)

    def test_bound_startup_logs_drive_threshold_without_changing_canonical_counts(self):
        repo = self.root / "startup-guest"
        repo.mkdir()
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        (repo / "source").write_text("fixture")
        subprocess.run(["git", "-C", str(repo), "add", "source"], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(repo),
                "-c",
                "user.name=fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
        )
        ref = subprocess.check_output(
            ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True
        ).strip()
        scope = {"__name__": "offline_status_payload"}
        exec(M["REMOTE"], scope)
        payload = dict(
            machine=self.mid,
            source_ref=ref,
            epoch=self.epoch,
            identity_path="/tmp/gate/repo/.context/original600-supervisor.fixture.json",
        )
        write(
            repo / ".context/original600-supervisor.fixture.json",
            dict(
                schema="original600-supervisor-identity-v1",
                machine=self.mid,
                source_ref=ref,
                epoch=self.epoch,
                pid=812,
            ),
        )
        ns = hashlib.sha256(
            (float(self.epoch).hex() + ":boot-fixture").encode()
        ).hexdigest()[:24]
        campaign = (
            repo
            / ".context/benchmarks/campaigns"
            / ("campaign-qualified600-" + ns + "-812")
        )
        jobs = []
        metas = []
        logs = []
        for index in range(1, 35):
            ident = f"r001-j{index:04d}"
            task = f"task-{index}"
            pid = 2000 + index
            owner = f"{index:032x}"
            run_id = f"20261017-083021-{pid}"
            fleet = repo / ".context/fleet/runs" / run_id
            log = campaign / (ident + ".log")
            logs.append(log)
            meta = repo / ".git/cloudbench-fleet-ownership" / owner / "meta"
            meta.parent.mkdir(parents=True)
            meta.write_text(
                f"version=2\napp=navi-whisper-lux-bench\nhost={self.mid}\npid={pid}\nfleet_owner_token={owner}\nrun_id={run_id}\nworkspace_root={repo}\n"
            )
            metas.append(meta)
            successor = dict(
                controller_id=self.mid,
                harness_ref=ref,
                task_ref=M['RUNNER']['TASK_REF'],
                owner_token=owner,
                run_id=run_id,
                task=task,
                ordinal=0,
                campaign_job_id=ident,
                campaign_total_jobs=600,
                campaign_attempt=1,
            )
            write(fleet / task / "archived-successor.json", successor)
            write(
                fleet / task / "archived-reuse-journal/source-exclusion.json",
                dict(
                    proof=dict(
                        schema="cloudbench-archived-reuse-v1",
                        successor=successor,
                        native_marker=dict(successor=successor),
                    )
                ),
            )
            header = f"    {repo}/scripts/run-bench monitor {fleet}\n    owner: {owner}; private controller diagnostics stay in this run directory.\n"
            failure = (
                "Traceback (most recent call last):\n"
                '  File "/tmp/cloudbench-scripts.'
                + "a"
                * 32
                + '/cloudbench-archived-machine-reuse.py", line 364, in claim_native\n'
                "    observed = wait_inactive(api, url, ack)\n"
                '  File "/tmp/cloudbench-scripts.'
                + "a"
                * 32
                + '/cloudbench-archived-reuse-effects.py", line 128, in wait_inactive\n'
                '    need(time.monotonic() <= deadline, "late inactive native version observation")\n'
                "ValueError: late inactive native version observation\n"
                f"❌ [{task}] provisioning failed (no machine) — skipping\n"
                "❌ no benches launched (all clones failed).\n"
            )
            if index == 31:
                body = header + "infra canary already failed; aborting follower\n"
            elif index == 32:
                body = failure + header + "healthy startup\n"
            elif index == 33:
                body = header + failure.replace(
                    "ValueError: late inactive native version observation",
                    "ValueError: unrelated",
                )
            elif index == 34:
                body=header+('Traceback (most recent call last):\n'
                    '  File "/tmp/cloudbench-scripts.'+'a'*32+'/cloudbench-campaign-env.py", line 253, in check\n'
                    'ValueError: environment-check identity/deadline changed before publication\n'
                    '❌ Cloud benchmark environment is not ready; no benchmark machine was started.\n')
            elif index in (29,30):
                body=header+('Traceback (most recent call last):\n'
                    '  File "/tmp/cloudbench-scripts.'+'a'*32+'/cloudbench-campaign-env.py", line 190, in check\n'
                    '    raise ValueError("environment-check identity changed while waiting")\n'
                    'ValueError: environment-check identity changed while waiting\n'
                    '❌ Cloud benchmark environment is not ready; no benchmark machine was started.\n')
            else:
                body = header + failure
            log.parent.mkdir(parents=True, exist_ok=True)
            log.write_text(body)
            attempts = (
                [
                    dict(
                        attempt=1,
                        log=str(log),
                        controller_pid=pid,
                        infra_failure=True,
                        status="cancelled",
                    )
                ]
                if index == 1
                else []
            )
            jobs.append(
                dict(
                    job_id=ident,
                    task=task,
                    controller_pid=pid,
                    attempt=1,
                    log=str(log),
                    status="running",
                    startup_cohort="c001",
                    attempts=attempts,
                )
            )
        jobs += [
            dict(job_id=f"r001-j{i:04d}", task=f"task-{i}", status="queued", attempts=[],
                 controller_pid=None,started_at=None,log=str(campaign/f"r001-j{i:04d}.log"))
            for i in range(35, 601)
        ]
        summary = dict(
            total_jobs=600,
            campaign_id=campaign.name,
            e2e_started_at_epoch=self.epoch,
            jobs=jobs,
        )
        write(campaign / "summary.json", summary)
        cohort_path=campaign/'startup-cohorts/c001/manifest.json'
        cohort=dict(cohort_id='c001',jobs={job['job_id']:job.get('controller_pid') for job in jobs})
        write(cohort_path,cohort)

        def observe():
            with patch.dict(os.environ, FLY_MACHINE_ID=self.mid):
                return scope["guest_status"](payload, repo, "boot-fixture")["summary"]

        counts = observe()
        self.assertEqual(counts["canonical_infra_affected_jobs"], 1)
        self.assertEqual(counts["original_startup_infra_affected_jobs"], 30)
        self.assertEqual(counts["combined_infra_affected_jobs"], 30)
        self.assertTrue(counts["infra_stop_required"])
        self.assertEqual(len(counts["original_startup_failure_evidence"]), 30)
        self.assertEqual(counts["terminal_attempts"], 0)
        self.assertFalse(counts["benchmark_success_inferred"])
        self.assertEqual(sum(p['reason']=='shared_environment_identity_changed' for p in counts['original_startup_failure_evidence']),2)
        # A shard binds archived-reuse successors to its group total, not a fixed 600.
        unsharded = payload
        payload = dict(unsharded, campaign_total_jobs=599)
        self.assertEqual(observe()['original_startup_infra_affected_jobs'], 2)
        payload = dict(unsharded, campaign_total_jobs=600)
        self.assertEqual(observe()['original_startup_infra_affected_jobs'], 30)
        payload = unsharded
        cohort['jobs']['r001-j0029']=9999;write(cohort_path,cohort)
        self.assertEqual(observe()['original_startup_infra_affected_jobs'],29)
        cohort['jobs']['r001-j0029']=2029;write(cohort_path,cohort)
        meta29=metas[28].read_bytes();metas[28].unlink()
        self.assertEqual(observe()['original_startup_infra_affected_jobs'],30)
        metas[28].write_bytes(meta29)
        # A changed owner/PID, arbitrary summary log path and task mismatch
        # cannot turn nearby failure text into evidence for this exact job.
        original = metas[1].read_text()
        metas[1].write_text(original.replace("pid=2002", "pid=9999"))
        self.assertEqual(observe()["original_startup_infra_affected_jobs"], 29)
        metas[1].write_text(original)
        # The immutable source-exclusion/successor pair survives registry
        # retirement; a missing meta is not a missing binding.
        metas[1].unlink()
        self.assertEqual(observe()["original_startup_infra_affected_jobs"], 30)
        metas[1].write_text(original)
        successor_path = (
            repo / ".context/fleet/runs/20261017-083021-2002/task-2/archived-successor.json"
        )
        successor_bytes = successor_path.read_bytes()
        write(successor_path, dict(json.loads(successor_bytes), harness_ref="0" * 40))
        self.assertEqual(observe()["original_startup_infra_affected_jobs"], 29)
        successor_path.write_bytes(successor_bytes)
        wrong_ref=dict(json.loads(successor_bytes),task_ref='b'*40)
        exclusion_path=successor_path.parent/'archived-reuse-journal/source-exclusion.json'
        exclusion_bytes=exclusion_path.read_bytes();exclusion=json.loads(exclusion_bytes)
        exclusion['proof']['successor']=wrong_ref
        exclusion['proof']['native_marker']['successor']=wrong_ref
        write(exclusion_path,exclusion)
        write(successor_path,wrong_ref)
        self.assertEqual(observe()['original_startup_infra_affected_jobs'],29)
        successor_path.write_bytes(successor_bytes)
        exclusion_path.write_bytes(exclusion_bytes)
        jobs[1]["log"] = str(logs[0])
        write(campaign / "summary.json", summary)
        self.assertEqual(observe()["original_startup_infra_affected_jobs"], 29)
        jobs[1]["log"] = str(logs[1])
        jobs[1]["task"] = "wrong-task"
        write(campaign / "summary.json", summary)
        self.assertEqual(observe()["original_startup_infra_affected_jobs"], 29)
        jobs[1]["task"] = "task-2"
        write(campaign / "summary.json", summary)
        # No symlink following, even inside the right campaign directory.
        raw = logs[1].read_bytes()
        logs[1].unlink()
        logs[1].symlink_to(logs[0])
        self.assertEqual(observe()["original_startup_infra_affected_jobs"], 29)
        logs[1].unlink()
        logs[1].write_bytes(raw)
        logs[1].write_bytes(b"x" * (256 * 1024 + 1))
        result = observe()
        self.assertEqual(result["original_startup_infra_affected_jobs"], 29)
        self.assertGreater(result["startup_evidence_unavailable_jobs"], 0)

    def test_observation_and_lease_wire_deadlines_keep_exact_startup_bindings(self):
        remote = self.root / 'status-fixture.py'
        remote.write_text(M['REMOTE'])
        scope = runpy.run_path(str(remote), run_name='offline_status_payload')
        repo = self.root / 'deadline-guest'
        campaign = repo / '.context/benchmarks/campaigns/exact'
        ident, task, pid, owner = ('r001-j0055', 'actual-task', 2907, 'a' * 32)
        fleet_id = '20261017-094932-2907'
        fleet = repo / '.context/fleet/runs' / fleet_id
        task_dir = fleet / task
        log = campaign / (ident + '.log')
        snapshot = '/tmp/cloudbench-scripts.' + 'b' * 32
        module = snapshot + '/cloudbench-archived-machine-reuse.py'
        effects = snapshot + '/cloudbench-archived-reuse-effects.py'
        wire = task_dir / 'archived-reuse-wire' / ('c' * 32)
        successor = {'controller_id': self.mid, 'harness_ref': self.ref, 'task_ref': M['RUNNER']['TASK_REF'], 'owner_token': owner, 'run_id': fleet_id, 'task': task, 'ordinal': 0, 'campaign_job_id': ident, 'campaign_total_jobs': 600, 'campaign_attempt': 1}
        proof = {'schema': 'cloudbench-archived-reuse-v1', 'successor': successor, 'machine_id': '11111111111111', 'claim_id': 'd' * 32, 'native_marker': {'successor': successor, 'machine_id': '11111111111111', 'claim_id': 'd' * 32}}
        write(task_dir / 'archived-successor.json', successor)
        exclusion_path = task_dir / 'archived-reuse-journal/source-exclusion.json'
        write(exclusion_path, {'proof': proof})
        request = {'app': 'navi-whisper-lux-bench', 'method': 'POST', 'path': '/machines/11111111111111/lease', 'body': {'ttl': 180, 'description': 'archived same-volume successor'}, 'timeout': 20, 'headers': {}}
        write(wire / 'request.json', request)
        write(wire / 'transport-start.json', {'monotonic_ns': 123, 'direct': False})
        header = f'    {repo}/scripts/run-bench monitor {fleet}\n    owner: {owner}; private controller diagnostics stay in this run directory.\n'
        prefix = 'Traceback (most recent call last):\n' + f'  File "{module}", line 332, in claim_native\n'
        suffix = f'❌ [{task}] provisioning failed (no machine) — skipping\n❌ no benches launched (all clones failed).\n'
        observation = prefix + f'  File "{effects}", line 199, in wait_inactive\n' + f'  File "{effects}", line 145, in observe_inactive\n' + f'  File "{effects}", line 134, in request\n' + f'  File "{effects}", line 86, in wire\n' + f'  File "{module}", line 44, in private\n' + f'  File "{effects}", line 176, in expire\n' + '<run_path>.ObservationDeadline: inactive native observation deadline\n' + suffix
        save_failure = observation.replace(f'  File "{module}", line 44, in private', f'  File "{effects}", line 102, in perform_wire\n  File "{module}", line 50, in save')
        argv = [str(repo / 'agents/venv/bin/python3'), '-S', module, 'wire', str(wire)]
        lease = prefix + f'  File "{effects}", line 149, in lease\n' + f'  File "{effects}", line 85, in wire\n' + f'  File "{effects}", line 108, in _run_wire\n' + '  File "/usr/lib/python3.11/subprocess.py", line 1989, in _wait\n' + f"subprocess.TimeoutExpired: Command '{argv}' timed out after 24.999969649999912 seconds\n" + suffix
        direct_lease = prefix + f'  File "{effects}", line 170, in lease\n' + f'  File "{effects}", line 156, in _lease_wire\n' + f'  File "{effects}", line 87, in wire\n' + f'  File "{effects}", line 193, in expire\n' + '<run_path>.NativeWireDeadline: native lease wire deadline\n' + suffix
        job = {'job_id': ident, 'task': task, 'log': str(log), 'attempt': 1, 'controller_pid': pid, 'status': 'failed', 'attempts': []}
        summary = {'total_jobs': 600, 'jobs': [job]}
        payload = {'machine': self.mid, 'source_ref': self.ref, 'epoch': self.epoch}

        def evidence(body):
            log.parent.mkdir(parents=True, exist_ok=True)
            log.write_text(body)
            return scope['startup_evidence'](summary, repo, campaign, payload)
        ssl_failure = observation.replace(f'  File "{module}", line 44, in private', '  File "/usr/lib/python3.11/ssl.py", line 1382, in do_handshake')
        for failure in (observation, save_failure, ssl_failure, lease, direct_lease):
            with self.subTest(failure=failure.splitlines()[-3]):
                actual = evidence(header + failure)
                self.assertEqual(len(actual['proofs']), 1)
                self.assertEqual(actual['proofs'][0]['job_id'], ident)
                canonical = dict(job, attempts=[{'status': 'failed', 'finished_at': 'then', 'infra_failure': True}])
                counts = scope['project']({'total_jobs': 600, 'jobs': [canonical] + [{'job_id': f'queued-{i}', 'status': 'queued', 'attempts': []} for i in range(599)]}, actual)
                self.assertEqual(counts['canonical_infra_affected_jobs'], 1)
                self.assertEqual(counts['combined_infra_affected_jobs'], 1)
                self.assertEqual(evidence(failure + header)['proofs'], [])
                self.assertEqual(evidence(header + failure.replace('claim_native', 'retire_native'))['proofs'], [])
                self.assertEqual(evidence(header + failure.replace(suffix, 'canary already failed\n'))['proofs'], [])
        direct = evidence(header + direct_lease)['proofs'][0]
        self.assertEqual(direct['reason'], 'archived_reuse_direct_lease_deadline')
        self.assertEqual(direct['native_lease_outcome'], 'unknown')
        self.assertEqual(evidence(header + direct_lease.replace('in _lease_wire', 'in unrelated'))['proofs'], [])
        for change in ({'method': 'GET'}, {'path': '/machines/22222222222222/lease'}, {'timeout': 30}):
            write(wire / 'request.json', dict(request, **change))
            self.assertEqual(evidence(header + lease)['proofs'], [])
        write(wire / 'request.json', request)
        self.assertEqual(evidence(header + lease.replace(str(wire), str(wire.parent / ('e' * 32))))['proofs'], [])
        for key, value in (('harness_ref', 'e' * 40), ('campaign_attempt', 2), ('owner_token', 'f' * 32)):
            write(task_dir / 'archived-successor.json', dict(successor, **{key: value}))
            self.assertEqual(evidence(header + lease)['proofs'], [])
        write(task_dir / 'archived-successor.json', successor)
        actual = evidence(header + lease + lease)
        self.assertEqual(len(actual['proofs']), 1)

    def test_one_native_exec_is_readonly_and_unknown_envelopes_do_not_fake_summary(self):
        value=M['binding'](self.run);calls=[]
        result=dict(status='SUPERVISOR_NOT_PUBLISHED',machine=self.mid,source_ref=self.ref,original_epoch=self.epoch)
        class API:
            def api(inner,method,path,body,timeout):
                calls.append((method,path,body,timeout))
                if len(json.dumps(body).encode())>16384:
                    return {'stdout':'','stderr':'PayloadTooLarge','exit_code':0}
                return dict(stdout=json.dumps(result),stderr='',exit_code=0)
        actual=M['observe'](API(),value)
        self.assertEqual(actual['status'],'SUPERVISOR_NOT_PUBLISHED');self.assertEqual(len(calls),1)
        self.assertEqual(calls[0][:2],('POST','/machines/'+self.mid+'/exec'))
        import shlex
        argv=shlex.split(calls[0][2]['cmd']);self.assertEqual(argv[:3],['python3','-S','-c'])
        import base64
        import gzip
        source,encoded=json.loads(gzip.decompress(base64.b64decode(argv[4])))
        self.assertEqual(source,M['REMOTE'])
        self.assertEqual(json.loads(base64.b64decode(encoded)),value['payload'])
        self.assertLessEqual(len(json.dumps(calls[0][2]).encode()),16384)
        old=shlex.join(['python3','-S','-c',M['REMOTE'],encoded])
        self.assertGreater(len(json.dumps({'cmd':old,'timeout':20,'machine':True}).encode()),16384)
        result['machine']='ffffffffffffff'
        with self.assertRaises(ValueError):M['observe'](API(),value)
        class Failed:
            def api(inner,*args,**kwargs):return dict(exit_code=1,stderr='fixture failure')
        self.assertEqual(M['observe'](Failed(),value)['status'],'TRANSPORT_UNKNOWN')

    def test_private_wire_precedes_decode_and_no_response_capture_failure_stays_unknown(self):
        import contextlib
        import io

        value = M['binding'](self.run)
        value['source_files'] = {'run-original600-controller.py': '1' * 64,
                                 'cloudbench-original-volume-capture.py': '2' * 64}
        calls = []
        state = {'mode': 'malformed'}
        token = 'fixture-private-token'
        test = self

        class CaptureFailure(Exception):
            pass

        class API:
            authorization = 'Bearer ' + token

            def __init__(self, app, credential):
                test.assertEqual(credential, token)

            def api(self, method, path, body, timeout, observer):
                calls.append((method, path, timeout))
                if state['mode'] != 'timeout':
                    raw = b'{malformed complete native response'
                    observer(method, path, 200, raw)
                    journals = list(test.run.glob('original600-status-wire-*'))
                    test.assertTrue(any((journal / 'wire.json').exists() for journal in journals))
                    return json.loads(raw)
                raise CaptureFailure('Machines API POST /machines/' + test.mid +
                                     '/exec failed: The read operation timed out; ' + token)

        def source(_root, _ref, name, _expected):
            return {'Fly': API} if 'volume-capture' in name else {'token_from_agents': lambda _: token}

        original_save = M['save']

        def partial_save(path, value):
            if state['mode'] == 'partial' and Path(path).name == 'wire.json':
                Path(path).write_bytes(b'')
                Path(path).chmod(0o600)
                raise OSError('fixture ENOSPC during observer save')
            original_save(path, value)

        with patch.dict(M['main'].__globals__, binding=lambda *_args: value, bound_source=source, save=partial_save):
            for mode in ('malformed', 'timeout', 'partial'):
                state['mode'] = mode
                malformed = mode == 'malformed'
                stdout = io.StringIO()
                with contextlib.redirect_stdout(stdout):
                    self.assertEqual(M['main'](['--run-dir', str(self.run)]), 1)
                result = json.loads(stdout.getvalue())
                self.assertEqual(result['status'], 'TRANSPORT_UNKNOWN')
                journal = Path(result['journal'])
                request = json.loads((journal / 'request.json').read_text())
                self.assertEqual((request['http_timeout'], request['absolute_timeout'], request['outer_timeout']), (20, 25, 30))
                failure = json.loads((journal / 'failure.json').read_text())
                complete = json.loads((journal / 'complete.json').read_text())
                self.assertEqual(complete['response_observed'], malformed)
                self.assertNotIn(token, stdout.getvalue())
                self.assertNotIn(token, (journal / 'failure.json').read_text())
                if malformed:
                    self.assertEqual(failure['error_type'], 'JSONDecodeError')
                    self.assertTrue((journal / 'wire.json').exists())
                elif mode == 'timeout':
                    self.assertEqual(failure['error_type'], 'CaptureFailure')
                    self.assertIn('read operation timed out', failure['message'])
                    self.assertFalse((journal / 'wire.json').exists())
                    self.assertFalse((journal / 'response.json').exists())
                else:
                    self.assertEqual(failure['error_type'], 'OSError')
                    self.assertTrue(complete['wire_artifact_present'])
                    self.assertTrue(complete['wire_capture_incomplete'])
                    self.assertEqual((journal / 'wire.json').read_bytes(), b'')
                    self.assertFalse((journal / 'response.json').exists())
                self.assertEqual(journal.stat().st_mode & 0o777, 0o700)
                self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in journal.iterdir()))
        self.assertEqual(calls, [('POST', '/machines/' + self.mid + '/exec', 20)] * 3)

    def test_local_terminal_or_unpublished_controller_requires_no_credential_or_provider(self):
        (self.run/'controller.identity.json').unlink()
        self.assertEqual(M['binding'](self.run)['mode'],'CONTROLLER_NOT_PUBLISHED')
        write(self.run/'terminal.json',dict(source_ref=self.ref,status='FAILED_BEFORE_PROVIDER_DISPATCH'))
        value=M['binding'](self.run)
        self.assertEqual(value['mode'],'LOCAL_TERMINAL')
        self.assertEqual(value['terminal']['status'],'FAILED_BEFORE_PROVIDER_DISPATCH')
        result=subprocess.run(['python3',str(ROOT/'scripts/run-original600-controller.py'),'--status','--run-dir',str(self.run)],cwd='/',capture_output=True,text=True,timeout=3)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['provider_calls'],0)
        self.assertEqual(json.loads(result.stdout)['mode'],'LOCAL_TERMINAL')


if __name__=='__main__':unittest.main()
