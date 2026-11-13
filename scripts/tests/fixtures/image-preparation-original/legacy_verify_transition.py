def verify_transition(intent, complete):
    need(intent['schema'] == complete['schema'] == SCHEMA and complete['intent_sha256'] == digest(intent), 'native intent seal')
    need(re.fullmatch('[0-9a-f]{32}', intent['nonce']) is not None
         and complete['nonce'] == intent['nonce'] and complete['producer'] == intent['producer']
         and intent['producer']['start'] and complete['native_exit'] == 0 and complete.get('qualified') is True,
         'nonce/producer/native exit')
    need(complete['cleanup_complete'] is False and complete['credit_granted'] is False,
         'maintenance grants no cleanup/credit')
    before, after = intent['before'], complete['after']
    old, new = before['warm'], after['warm']
    need(intent['started_at'] <= before['observed_at'] <= complete['finished_at']
         and before['observed_at'] <= after['observed_at'] <= complete['finished_at'], 'native chronology')
    need(before['guard']['boot'] == after['guard']['boot'] and before['guard']['uid'] == after['guard']['uid'], 'observer incarnation')
    need(intent['targets'] == [['warm', old['id']]] and old['id'] == new['id'] and old['name'] == new['name']
         and old['state'] == new['state'] == 'stopped' and old['instance_id'] and new['instance_id'], 'exact stopped warm target')
    need(old['stable_sha256'] == new['stable_sha256'] and old['mounts'] == new['mounts']
         and before['volumes'] == after['volumes'], 'foreign config/volume delta')
    need(new['image'] == intent['image'] and new['image_digest'] == intent['image_digest'], 'image digest changed')
    need(new['guest'] == {'cpu_kind': 'shared', 'cpus': 1, 'memory_mb': 2048}
         and new['command'] == ['sleep', 'infinity'], 'only native default parked shape/command allowed')
    need(set(before['inventory']) == set(after['inventory']) and old['id'] in before['inventory'], 'extra/missing inventory target')
    need(all(after['inventory'][key] == value for key, value in before['inventory'].items() if key != old['id']),
         'foreign machine changed')
    for observation_value in (before, after):
        warm = observation_value['warm']; row = observation_value['inventory'][warm['id']]
        need(row == {k: warm[k] for k in ('name', 'instance_id', 'state', 'config_sha256')}, 'inventory/warm mismatch')
