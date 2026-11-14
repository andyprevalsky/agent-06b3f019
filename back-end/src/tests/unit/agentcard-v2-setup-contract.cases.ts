import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Default REST routing must preserve the product attention contract and issue signed v2 setup. */
export function assertV2SetupResumeContract(backendDir: string): void {
  const folder = mkdtempSync(path.join(tmpdir(), 'v2-setup-contract-'));
  const guard = path.join(folder, 'preload.cjs');
  const payload = path.join(folder, 'payload.json');
  writeFileSync(
    guard,
    String.raw`
const Module=require('node:module');const fs=require('node:fs');const path=require('node:path');
const localRequire=Module.createRequire(path.join(process.cwd(),'package.json'));
const put=(file,value)=>{const id=localRequire.resolve(file);const mod=new Module(id);mod.loaded=true;mod.exports=value;require.cache[id]=mod;};
const file=rel=>path.join(process.cwd(),'src/providers',rel);
global.fetch=async()=>{throw new Error('UNEXPECTED_VENDOR_CALL');};
require('node:net').Socket.prototype.connect=()=>{throw new Error('UNEXPECTED_REAL_NETWORK_OR_DATABASE');};
const never=async()=>{throw new Error('LEGACY_CARDHOLDER_OR_USER_OAUTH_FORBIDDEN');};
put(file('agentcard/store.ts'),{getV2ConnectedUserId:async()=>process.env.SETUP_SCENARIO==='stale'?'usr_stale':undefined,
 getV2CredentialClientId:()=>process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID,getOrgManagedCardholderId:never});
put(file('database.ts'),{prisma:{purchaseSpend:{findUnique:async()=>({id:'setup-contract',userId:'rose-setup-user',totalCents:100,stripeLivemode:false,walletFunding:{purchaseId:'setup-contract',userId:'rose-setup-user',amountCents:100,currency:'usd',metadata:{cardProviderRail:'v2'}}})}}});
const state=new Map();
put(file('sharedState.ts'),{getEphemeral:async(ns,key)=>state.get(ns+':'+key),
 putEphemeral:async(ns,key,value)=>{state.set(ns+':'+key,value);},withSerializedLock:async(_key,fn)=>fn()});
class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;this.details={};}}
put(file('agentcard/api-v2.ts'),{AgentCardV2Error:ApiError,agentCardV2Request:async(method,resource,body)=>{
 if(process.env.SETUP_SCENARIO!=='stale')throw new Error('Missing binding must not attempt a provider call');
 if(method==='GET'&&resource==='/api/v2/company_wallet')return {livemode:false,default_funds_source:'company_flow'};
 if(method==='POST'&&resource==='/api/v2/cards'){
  if(body.user_id!=='usr_stale')throw new Error('Never alias a legacy cardholder as user_id');
  throw new ApiError('Connection no longer exists',404,'connection_not_found');
 }
 throw new Error('Unexpected v2 call '+method+' '+resource);
}});
`
  );
  const probe = String.raw`
const assert=require('node:assert/strict');const fs=require('node:fs');
const {AgentCardRoutingProvider}=require('./src/providers/card-provider/agentcard-routing.ts');
const {AgentCardProviderError}=require('./src/providers/card-provider/errors.ts');
const {verifyConnectToken}=require('./src/providers/agentcard/config.ts');
(async()=>{
 const provider=new AgentCardRoutingProvider('rose-setup-user');
 let setup;
 try{await provider.mintCard({fundsSource:'company_flow',amountCents:100,idempotencyKey:'purchase:setup-contract',expectedLivemode:false});}
 catch(error){assert.ok(error instanceof AgentCardProviderError);assert.equal(error.status,409);assert.equal(error.code,'agentcard_setup_required');setup={status:'agentcard_setup_required',code:error.code,...error.details};}
 assert.ok(setup,'missing or stale v2 connection must return setup, never mint a replacement');
 fs.writeFileSync(process.env.SETUP_PAYLOAD,JSON.stringify(setup));
 const url=new URL(setup.setupUrl);
 assert.equal(url.pathname,'/api/agentcard/v2/connect');assert.equal(url.searchParams.get('user'),'rose-setup-user');
 assert.ok(url.searchParams.get('session'));assert.equal(verifyConnectToken('rose-setup-user',url.searchParams.get('t')),true);
 assert.equal(verifyConnectToken('different-user',url.searchParams.get('t')),false);
 assert.equal(setup.setupAction,'complete_agentcard_cardholder_onboarding');
 assert.equal(setup.agentcardStatus,'cardholder_onboarding_required',
   'Expected attention kind agentcard_user_cardholder_onboarding_required, observed agentcard_user_'+setup.agentcardStatus);
 assert.equal(setup.setupStatus,'connection_required','provider connection state remains separately available');
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
`;
  try {
    for (const scenario of ['unmapped', 'stale']) {
      const result = spawnSync(
        process.execPath,
        ['--require', guard, '--import', 'tsx', '--eval', probe],
        {
          cwd: backendDir,
          encoding: 'utf8',
          timeout: 15_000,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            AGENTCARD_ORG_OAUTH_CLIENT_ID: 'unit-setup-scope',
            AGENTCARD_CONNECT_SECRET: 'unit-connect-signing-secret',
            AGENTCARD_PUBLIC_URL: 'https://rose.example.test',
            SETUP_SCENARIO: scenario,
            SETUP_PAYLOAD: payload,
          },
        }
      );
      const evidence = process.env.SETUP_RESUME_EVIDENCE_DIR;
      if (evidence !== undefined && evidence !== '') {
        mkdirSync(evidence, { recursive: true });
        try {
          writeFileSync(path.join(evidence, `${scenario}.json`), readFileSync(payload));
        } catch {
          /* A pre-contract failure may not produce a payload. */
        }
      }
      assert.equal(result.signal, null, `${scenario} must finish without a timeout`);
      assert.equal(result.status, 0, `${scenario}: ${result.stderr}`);
    }
    process.stdout.write(
      'PASS default v2 routing preserves setup-resume attention and signed scoped v2 URL\n'
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
