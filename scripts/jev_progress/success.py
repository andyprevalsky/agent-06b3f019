"""Positive task-success evidence, distinct from lifecycle or tool completion."""
import re

COMPLETION_TOOLS = {'attempt_completion', 'attempt_completion_with_result'}
INTERRUPTED = ('new code version deployed, retry this tool', 'tool interrupted by deployment')


def terminal_ids(trace):
    last=next((e for e in reversed(trace['events']) if e['role']=='assistant'),None)
    if not last:return set()
    return {c.get('tool_call_id') or c.get('id') for c in last.get('calls',[])
            if (c.get('tool') or c.get('name') or c.get('function',{}).get('name')) in COMPLETION_TOOLS}


def success_verdict(trace, evidence):
    """Fail closed; unknown success is quarantined, not relabelled as failure."""
    if trace['kind'] not in ('normal_root','normal_child'):
        # Archive task_complete/browser teardown proves lifecycle termination,
        # not goal success. An explicit task-bound outcome is necessary.
        receipt=trace.get('terminal_receipt') or {}
        md=receipt.get('metadata') or {}
        task=md.get('task_id') or md.get('taskId') or md.get('subAgentId')
        outcome=md.get('outcome') or md.get('task_status')
        if task==trace['trace_id'] and outcome=='SUCCEEDED' and md.get('success') is True:
            return True,'explicit_task_succeeded'
        return False,'missing_task_success_evidence'
    if not evidence or evidence.get('id')!=trace['trace_id']:
        return False,'missing_persisted_outcome'
    if evidence.get('status')!='COMPLETED':return False,'agent_not_completed'
    md=evidence.get('metadata') or {}
    if md.get('toolCallId') not in terminal_ids(trace):return False,'terminal_call_mismatch'
    if md.get('toolStatus') not in ('FINISHED','COMPLETED'):return False,'terminal_not_finished'
    text=(evidence.get('text') or '').lower()
    if any(marker in text for marker in INTERRUPTED):return False,'deployment_interruption'
    if md.get('supersededByUserFeedback'):return False,'superseded_verifier'
    if md.get('phase')=='PLAN':return False,'plan_only_completion'
    title=md.get('title') or ''
    score=re.search(r'(?:Progress:\s*|Verifier[^\d]*)(\d+(?:\.\d+)?)%',title,re.I)
    if md.get('verifierMessage') is not True or not score:return False,'missing_verifier_success'
    if float(score.group(1))!=100:return False,'verifier_rejected'
    if re.search(r'Verifier score:\s*(\d+(?:\.\d+)?)%',evidence.get('text') or '',re.I):
        return False,'conflicting_verifier_result'
    return True,'terminal_verifier_100_percent'
