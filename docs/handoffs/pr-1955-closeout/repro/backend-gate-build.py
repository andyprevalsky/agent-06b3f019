"""Build the exact Blacksmith backend-coverage-blackbox plan gate + request for the current HEAD,
the same way scripts/deploy gates does (template.json gate + deploy_gates.remote_slot binding)."""
import json, secrets, sys
from pathlib import Path
ROOT = Path('/home/boxes/rose')
sys.path.insert(0, str(ROOT / 'scripts'))
import deploy_gates
from deploy_test_bindings import generate as generate_bindings
from deploy_test_cycle import source
out = Path(sys.argv[1])
template = json.loads((ROOT / '.context/deploy-pipeline/template.json').read_text())
gate = next(g for g in template['gates'] if g['name'] == 'backend-coverage-blackbox')
inventory = {'backend-coverage-blackbox': deploy_gates.remote_slot(ROOT, 'backend-coverage-blackbox')}
worker = generate_bindings({'gates': [gate]}, inventory, ROOT)['backend-coverage-blackbox']
gate = dict(gate, worker=worker['id'], command=worker['command'], cwd=worker.get('cwd', str(ROOT)),
            env={**gate.get('env', {}), **worker.get('env', {})}, worker_transport=worker.get('transport'))
for key in ('worker_root', 'timeout_seconds'):
    if key in worker:
        gate[key] = worker[key]
gate.update(worker_recipe=worker['recipe'], case_protocol=True)
assert set(gate['worker_recipe']['cases']) == set(gate['checks']), 'recipe/checks mismatch'
src = source(ROOT)
request = {'token': secrets.token_hex(16), 'source': src, 'gate': gate['name'], 'checks': gate['checks'],
           'skips': {}, 'phase': 'initial', 'worker_recipe': gate['worker_recipe'], 'worker_root': gate['worker_root']}
(out / 'gate.json').write_text(json.dumps(gate, indent=1))
(out / 'request.json').write_text(json.dumps(request, indent=1))
print(json.dumps({'command': gate['command'], 'env': gate['env'], 'checks': len(gate['checks']), 'source': src}))
