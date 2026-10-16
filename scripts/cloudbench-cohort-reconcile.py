#!/usr/bin/env python3
"""One full stale-registry reconciliation per exact sealed cleanup cohort."""
import argparse
import fcntl
import hashlib
import types
import os
import math
from pathlib import Path
import stat
import socket
import subprocess
import time


def retired(T,pid,expected):
    if T.birth(pid)!=expected:return True
    if Path('/proc/self/stat').exists():
        try:state=Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()[0]
        except FileNotFoundError:return T.birth(pid)!=expected
    else:
        state=subprocess.check_output(['ps','-p',str(pid),'-o','stat='],text=True).strip()
    # A zombie cannot execute or hold inherited descriptors. Keep unknown or
    # live states conservative; repeat the exact birth comparison after read.
    return state.startswith('Z') and T.birth(pid)==expected

def main():
    p=argparse.ArgumentParser()
    p.add_argument('action',choices=['acquire','complete'])
    for key in ['cohort','cohort-id','job','owner-start','app','ownership-root']:p.add_argument('--'+key,required=True)
    p.add_argument('--owner-pid',type=int,required=True);p.add_argument('--fd',type=int,required=True)
    p.add_argument('--status',type=int,default=0)
    a=p.parse_args()
    source=Path(__file__).with_name('cloudbench-cleanup-tickets.py')
    raw=source.read_bytes()
    if hashlib.sha256(raw).hexdigest()!='9427517b23cb47abc5c6bcc1e45ef88a615a895c822d8e73818ae6059755f360':raise ValueError('cleanup reconciliation dependency source changed')
    T=types.ModuleType('cleanup_tickets');T.__file__=str(source);exec(compile(raw,str(source),'exec'),T.__dict__)
    cohort=Path(a.cohort).resolve(strict=True);base=T.base_for(cohort)
    lock_path=cohort/'stale-reconcile.lock'
    info=T.physical(lock_path);opened=os.fstat(a.fd)
    T.need(stat.S_ISREG(opened.st_mode) and opened.st_nlink==1 and opened.st_uid==os.getuid() and not opened.st_mode&0o022 and (opened.st_dev,opened.st_ino)==(info.st_dev,info.st_ino),'reconciliation lock changed')
    def binding():
        budget,member=T.selected(base,a.job)
        T.need(budget['cohort_id']==a.cohort_id and T.parent_active(budget),'inactive reconciliation cohort')
        current=T.read(T.keyed(base,'current',a.job))
        owner=T.read(T.generation(base,'owners',a.job,current['generation']))
        T.need(current==owner and owner['owner_pid']==a.owner_pid and owner['owner_start']==a.owner_start and owner['budget_sha256']==T.digest(budget) and T.birth(a.owner_pid)==a.owner_start,'foreign reconciliation owner')
        T.need(not (base/'closing.json').exists(),'closing reconciliation cohort')
        root=Path(a.ownership_root);T.physical(root,True)
        T.need(root.resolve(strict=True)==Path(budget['reserve_root']).resolve(strict=True) and bool(a.app),'foreign reconciliation ownership root')
        return budget,dict(cohort=str(cohort),cohort_id=a.cohort_id,budget_sha256=T.digest(budget),app=a.app,ownership_root=str(root.resolve(strict=True)),host=socket.gethostname(),source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),fleet_sha256=hashlib.sha256(Path(__file__).with_name('run-bench-fleet').read_bytes()).hexdigest(),lock_identity=[info.st_dev,info.st_ino])
    budget,bound=binding();deadline=budget.get('deadline') or time.monotonic()+300
    with T.until(deadline):
        if a.action=='acquire':fcntl.flock(a.fd,fcntl.LOCK_EX)
        else:fcntl.flock(a.fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        budget,after=binding();T.need(after==bound,'reconciliation authority changed while waiting')
        done=cohort/'stale-reconcile.completed.json';failed=cohort/'stale-reconcile.failed.json';lease=cohort/'stale-reconcile.owner.json'
        def validate_winner(winner):
            T.need(set(winner)=={'binding','owner_pid','owner_start'} and winner['binding']==bound and type(winner['owner_pid']) is int and winner['owner_pid']>1 and isinstance(winner['owner_start'],str) and bool(winner['owner_start']),'invalid reconciliation winner')
        if a.action=='acquire':
            completed=done.exists() or done.is_symlink(); rejected=failed.exists() or failed.is_symlink()
            T.need(not (completed and rejected),'conflicting reconciliation terminals')
            if completed or rejected:
                receipt=T.read(done if completed else failed);winner=T.read(lease)
                validate_winner(winner)
                T.need(set(receipt)=={'binding','owner_pid','owner_start','status','finished_monotonic'} and all(receipt[k]==winner[k] for k in winner),'foreign reconciliation terminal')
                T.need(type(receipt['status']) is int and (receipt['status']==0 if completed else receipt['status']!=0),'invalid reconciliation terminal status')
                stamp=receipt['finished_monotonic'];T.need(type(stamp) in (int,float) and math.isfinite(stamp) and stamp>0,'invalid reconciliation terminal clock')
                return 0 if completed else 1
            if lease.exists():
                prior=T.read(lease);validate_winner(prior)
                T.need(retired(T,prior['owner_pid'],prior['owner_start']),'live reconciliation winner lost lock')
            T.write(lease,dict(binding=bound,owner_pid=a.owner_pid,owner_start=a.owner_start),replace=lease.exists())
            return 10
        expected=dict(binding=bound,owner_pid=a.owner_pid,owner_start=a.owner_start)
        T.need(T.read(lease)==expected,'reconciliation completion is not winner owned')
        T.need(not done.exists() and not failed.exists(),'reconciliation already terminal')
        T.write(done if a.status==0 else failed,dict(binding=bound,owner_pid=a.owner_pid,owner_start=a.owner_start,status=a.status,finished_monotonic=time.monotonic()))
        return 0 if a.status==0 else 1

if __name__=='__main__':raise SystemExit(main())
