"""Read-only cold observation guard; grants no guest, reuse, or mutation authority.

Only the reviewed static 8011/443 listener is admitted. Fly documents omitted
services.autostart as false (https://docs.fly.io/machines/flyctl/fly-machine-run/).
Unknown service controls remain refused. Callers retain their own identity,
custody, deadlines, freshness and final native equality checks.
"""
import json
from pathlib import Path
import runpy

def _need(value, message):
    """Explicit policy check; unlike assert it is not stripped by -O/PYTHONOPTIMIZE."""
    if not value:
        raise ValueError(message)

def validate_observation_services(config):
    """Only the observed static proxy listener, without any activation controls."""
    services=config.get('services',[])
    _need(isinstance(services,list) and len(services)<=1,'unsupported service list; untouched')
    if 'disable_machine_autostart' in config:
        _need(config['disable_machine_autostart'] is True,'legacy autostart conflict or ambiguity; untouched')
    _need(not any(key in config for key in ('autostart','auto_start_machines','auto_stop_machines')),'unknown top-level activation control; untouched')
    for service in services:
        allowed={'protocol','internal_port','ports','force_instance_key','autostart','autostop','min_machines_running'}
        _need(isinstance(service,dict) and set(service)<=allowed,'unknown service schema; untouched')
        _need(service.get('protocol')=='tcp' and type(service.get('internal_port'))is int and service['internal_port']==8011,'unsupported listener; untouched')
        _need(service.get('ports')==[{'handlers':['http','tls'],'port':443}],'unsupported public port; untouched')
        _need(service.get('force_instance_key') is None,'forced instance routing unsupported; untouched')
        if 'autostart' in service:_need(service['autostart'] is False,'service autostart enabled or ambiguous; untouched')
        if 'autostop' in service:_need(service['autostop'] is False or service['autostop']=='off','service autostop enabled or ambiguous; untouched')
        if 'min_machines_running' in service:_need(type(service['min_machines_running'])is int and service['min_machines_running']==0,'service minimum may activate machine; untouched')

def validate_observation_native(machine, original, before, after, volume):
    """Apply canonical cold identity checks before the service-only predicate."""
    helper = runpy.run_path(str(Path(__file__).with_name("cloudbench-startup-failure-archive.py")))
    proof = helper["current_cold_native"](machine, original, before, after, volume)
    native = json.loads(helper["read"](before, 1048576))
    validate_observation_services(native["config"])
    return proof
