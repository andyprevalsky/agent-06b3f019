#!/usr/bin/env python3
"""Exercise the production collector SQL against temporary PostgreSQL tables only."""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
query = (ROOT / 'back-end/scripts/biz-review-prompt-history.sql').read_text()
fixture = '''
CREATE TEMP TABLE "Agent" (id text, "userId" text, "parentAgentId" text, depth int,
 "isBenchmark" boolean, "worldModelMode" text);
CREATE TEMP TABLE "Message" (id text, "agentId" text, timestamp timestamptz,
 text text, role text, "workflowGeneration" text, metadata jsonb);
INSERT INTO "Agent" VALUES ('root','andy',NULL,0,false,'real'),
 ('other','other',NULL,0,false,'real'), ('child','andy','root',1,false,'real'),
 ('bench','andy',NULL,0,true,'real'), ('sim','andy',NULL,0,false,'simulated');
INSERT INTO "Message" VALUES
 ('first','root','2026-10-05 07:00Z','repeat','USER',NULL,NULL),
 ('repeat','root','2026-10-05 08:00Z','repeat','USER',NULL,NULL),
 ('key1','root','2026-10-19 08:00Z','real','USER',NULL,'{"clientMessageId":"a"}'),
 ('key2','root','2026-10-19 08:01Z','real','USER',NULL,'{"clientMessageId":"a"}'),
 ('attention1','root','2026-10-19 09:00Z','yes','USER',NULL,'{"attentionRequestId":"reply"}'),
 ('attention2','root','2026-10-19 09:01Z','yes','USER',NULL,'{"attentionRequestId":"reply"}'),
 ('tool','root','2026-10-19 08:00Z','tool','TOOL',NULL,NULL),
 ('assistant','root','2026-10-19 08:00Z','assistant','ASSISTANT',NULL,NULL),
 ('workflow','root','2026-10-19 08:00Z','internal','USER','gen',NULL),
 ('a2a','root','2026-10-19 08:00Z','internal','USER',NULL,'{"a2a":{}}'),
 ('schema','root','2026-10-19 08:00Z','schema','USER',NULL,'{"isResponseSchemaUpdate":true}'),
 ('summary','root','2026-10-19 08:00Z','summary','USER',NULL,'{"compactionSummary":true}'),
 ('empty','root','2026-10-19 08:00Z',' ','USER',NULL,NULL),
 ('child','child','2026-10-19 08:00Z','generated','USER',NULL,NULL),
 ('bench','bench','2026-10-19 08:00Z','generated','USER',NULL,NULL),
 ('sim','sim','2026-10-19 08:00Z','generated','USER',NULL,NULL),
 ('foreign','other','2026-10-19 08:00Z','private','USER',NULL,NULL),
 ('boundary','root','2026-10-26 07:00Z','next week','USER',NULL,NULL);
'''
def run(end, user='andy'):
    sql = query.replace('$1', "'" + end + "'").replace('$2', "'" + user + "'").rstrip().rstrip(';')
    command = ['psql', '-X', '-qAt', '-w', '-v', 'ON_ERROR_STOP=1', '-d', os.environ['TEST_DATABASE_URL']]
    result = subprocess.run(command, input='BEGIN;\n'+fixture+'\nSELECT COALESCE(json_agg(t),\'[]\'::json) FROM ('+sql+') t;\nROLLBACK;',
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout.strip())
assert run('2026-10-21 12:00Z') == [
    {'weekStart':'2026-10-05','count':2,'partial':False},
    {'weekStart':'2026-10-12','count':0,'partial':False},
    {'weekStart':'2026-10-19','count':2,'partial':True}]
assert run('2026-10-26 07:00Z')[-1] == {'weekStart':'2026-10-19','count':2,'partial':False}
assert run('2026-10-26 07:00:01Z')[-1] == {'weekStart':'2026-10-26','count':1,'partial':True}
assert run('2026-10-21 12:00Z','absent') == []
# Pacific daylight-saving transition: Nov 2 Monday starts at 08:00Z, not 07:00Z.
assert run('2026-11-02 07:30Z')[-1]['weekStart'] == '2026-10-26'
assert run('2026-11-02 08:00:01Z')[-1] == {'weekStart':'2026-11-02','count':0,'partial':True}

print('prompt history PostgreSQL tests passed: identity, scope, replay, zero weeks, exclusive Pacific and DST boundaries')
