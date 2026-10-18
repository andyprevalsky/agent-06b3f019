#!/usr/bin/env tsx
/** Actual phone migrations and role-switched SQL, isolated from the running backend. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
for (const key of ['DATABASE_URL', 'DIRECT_URL'])
  assert.equal(nonLocalDatabaseReason(process.env[key]), null, `${key} must be explicit loopback`);
const url = new URL(process.env.DIRECT_URL!);
const name = `victoria_iphone_rls_${randomUUID().replaceAll('-', '')}`;
const sql = (target: URL, input: string) =>
  execFileSync('psql', ['-X', target.toString(), '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const root = resolve(process.cwd(), 'prisma/migrations');
const migrations = readdirSync(root)
  .filter((d) => /_iphone_/.test(d))
  .sort()
  .map((d) => readFileSync(resolve(root, d, 'migration.sql'), 'utf8'))
  .join('\n');
const local = new URL(url);
local.pathname = `/${name}`;
try {
  sql(url, `CREATE DATABASE "${name}";`);
  process.stdout.write(
    sql(
      local,
      `BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('anon','authenticated') AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Invalid client-role fixture'; END IF;
END $$;
CREATE TABLE "User" ("userId" text PRIMARY KEY); CREATE TABLE "Agent" (id text PRIMARY KEY);
GRANT USAGE ON SCHEMA public TO anon, authenticated;
-- Documented legacy Supabase auto-grants, scoped only to this owned database.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
${migrations}
INSERT INTO "User" VALUES ('fixture-user'); INSERT INTO "Agent" VALUES ('fixture-agent');
INSERT INTO "IPhoneDevice" (id,"userId","providerDeviceId","updatedAt","providerSessionEncrypted") VALUES ('device','fixture-user','synthetic-device',now(),'synthetic-grant');
INSERT INTO "IPhoneLease" (id,"deviceId","userId","agentId","requestKey","queueDeadlineAt","updatedAt") VALUES ('lease','device','fixture-user','fixture-agent','acquire',now(),now());
INSERT INTO "IPhoneOperation" (id,"deviceId","leaseId","requestKey",operation,actor,"inputHash","requestEncrypted","providerEpoch","deadlineAt","updatedAt") VALUES ('operation','device','lease','command','input.text','user','synthetic-hmac','synthetic-request',0,now(),now());
INSERT INTO "IPhoneAcquireIntent" (id,"deviceId","browserTaskId","requestKey","leaseId") VALUES ('intent','device','task','intent','lease');
DO $$ DECLARE r text; t text; q text; denied int:=0; exposed text:=''; n int;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  FOREACH t IN ARRAY ARRAY['IPhoneDevice','IPhoneLease','IPhoneOperation','IPhoneAcquireIntent'] LOOP
   FOREACH q IN ARRAY ARRAY[format('SELECT * FROM %I',t),format('INSERT INTO %I SELECT * FROM %I WHERE false',t,t),format('UPDATE %I SET id=id',t),format('DELETE FROM %I',t)] LOOP
    BEGIN
     EXECUTE format('SET LOCAL ROLE %I',r);
     PERFORM set_config('request.jwt.claim.sub','fixture-user',true);
     EXECUTE q;
     exposed:=exposed || r || ':' || split_part(q,' ',1) || ':' || t || ' ';
     RESET ROLE;
    EXCEPTION WHEN insufficient_privilege THEN denied:=denied+1;
    END;
   END LOOP;
  END LOOP;
 END LOOP;
 IF denied<>32 THEN RAISE EXCEPTION 'Client CRUD exposed: % (denied %/32)',exposed,denied; END IF;
 SELECT count(*) INTO n FROM pg_class WHERE relname IN ('IPhoneDevice','IPhoneLease','IPhoneOperation','IPhoneAcquireIntent') AND relrowsecurity;
 IF n<>4 THEN RAISE EXCEPTION 'All four tables require RLS'; END IF;
 IF EXISTS(SELECT FROM pg_policies WHERE tablename IN ('IPhoneDevice','IPhoneLease','IPhoneOperation','IPhoneAcquireIntent')) THEN RAISE EXCEPTION 'Private tables must not have client policies'; END IF;
 FOREACH t IN ARRAY ARRAY['IPhoneDevice','IPhoneLease','IPhoneOperation','IPhoneAcquireIntent'] LOOP
  EXECUTE format('SELECT count(*) FROM %I',t) INTO n;
  IF n<>1 THEN RAISE EXCEPTION 'Owner read failed'; END IF;
  EXECUTE format('UPDATE %I SET id=id',t);
 END LOOP;
 DELETE FROM "IPhoneDevice" WHERE id='device';
 IF EXISTS(SELECT FROM "IPhoneLease") THEN RAISE EXCEPTION 'Owner delete/cascade failed'; END IF;
 RAISE NOTICE 'PASS: 32 client CRUD denials; four RLS/no-policy guards; backend owner CRUD/cascade';
END $$;
ROLLBACK;`
    )
  );
} catch (error) {
  const failure = error as { stderr?: string };
  process.stderr.write(failure.stderr ?? 'iPhone RLS SQL failed\n');
  process.exitCode = 1;
} finally {
  sql(url, `DROP DATABASE IF EXISTS "${name}";`);
}
