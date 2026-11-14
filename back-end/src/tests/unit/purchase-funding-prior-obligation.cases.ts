import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Real charge + v2 driver; only vendor, Stripe and persistence boundaries are injected. */
export function assertAmbiguousFundingRetryKeepsObligation(backendDir: string): void {
  const folder = mkdtempSync(path.join(tmpdir(), 'purchase-prior-obligation-'));
  const guard = path.join(folder, 'preload.cjs');
  writeFileSync(
    guard,
    String.raw`
const Module=require('node:module');const path=require('node:path');
const localRequire=Module.createRequire(path.join(process.cwd(),'package.json'));
const source=rel=>path.join(process.cwd(),'src',rel);
const put=(name,value)=>{const id=localRequire.resolve(name);const mod=new Module(id);mod.loaded=true;mod.exports=value;require.cache[id]=mod;};
global.fetch=async()=>{throw new Error('UNEXPECTED_VENDOR_CALL');};
require('node:net').Socket.prototype.connect=()=>{throw new Error('UNEXPECTED_REAL_DB_OR_NETWORK');};
const state=global.__financialReview={stage:1,purchase:null,funding:{id:'funding-one',status:'PENDING',providerTransferId:null},events:[]};
put(source('providers/database.ts'),{prisma:{}});
put(source('domains/purchases/repo.ts'),{
 findPurchaseById:async()=>state.purchase,
 updatePurchaseStatus:async(_id,status,extra)=>{state.events.push({kind:'purchase-state',status});Object.assign(state.purchase,{status,...extra});},
});
put(source('domains/purchases/walletFunding.ts'),{
 preparePurchaseWalletCollection:async()=>state.funding,
 discardPendingPurchaseWalletCollection:async()=>{state.events.push({kind:'discard-pending-marker'});state.funding=null;},
 confirmPurchaseWalletCollection:async()=>{throw new Error('unexpected collection');},
 recordIssuedPurchaseCardFunding:async(_purchase,_currency,cardId,transferId)=>{
  state.purchase.cardId=cardId;state.funding={...state.funding,status:'FUNDED',providerTransferId:transferId};
 },
 reclaimPurchaseWalletFunding:async()=>{throw new Error('cannot reclaim an unknown card');},
});
put(source('domains/purchases/archive.ts'),{archivePurchaseBoundary:async()=>{}});
put(source('domains/purchases/stripeCustomer.ts'),{getCustomerDefaultPaymentMethodId:async()=>{
 if(state.stage===2)throw new Error('Saved payment method lookup temporarily failed');return 'pm-test';
}});
const stripe={paymentIntents:{create:async(_body,options)=>{
 state.events.push({kind:'stripe-authorize',key:options.idempotencyKey});
 if(state.stage===4){const error=new Error('Payment method was declined');error.type='StripeCardError';throw error;}
 return {id:'pi-preserved',status:'requires_capture'};
}}};
put(source('providers/stripe.ts'),{
 getStripeClientForLivemode:mode=>{if(mode!==false)throw new Error('wrong mode');return stripe;},
 captureAuthorizedHold:async(id,mode)=>{state.events.push({kind:'stripe-capture',id,mode});},
 reversePurchasePaymentIntent:async(id,_purchase,mode)=>{state.events.push({kind:'stripe-reverse',id,mode});},
});
put(source('providers/agentcard/org-wallet-topup.ts'),{triggerOrgWalletTopUp:()=>{state.events.push({kind:'topup-request'});}});
`
  );
  const probe = String.raw`
const assert=require('node:assert/strict');
const {AgentCardV2Client}=require('./src/providers/agentcard/api-v2.ts');
const {AgentCardV2Provider}=require('./src/providers/card-provider/agentcard-v2.ts');
const {chargeAndIssueCard}=require('./src/domains/purchases/charge.ts');
const state=global.__financialReview;let now=Date.now();const creates=[];const cards=new Map();
const scenario=process.env.OBLIGATION_SCENARIO;
const card={id:'card-committed',transfer_id:'owt-committed',user_id:'usr-owned',status:'open',
 balance_cents:100,spend_limit_cents:100,last4:'4242',expiry:'12/30',type:'single_use'};
const api=new AgentCardV2Client(async(url,init)=>{
 if(String(url).endsWith('/oauth/token'))return new Response(JSON.stringify({access_token:'test-platform-token',expires_in:3600}));
 if(String(url).endsWith('/company_wallet'))return new Response(JSON.stringify({livemode:state.stage===3,default_funds_source:'company_flow'}));
 if(String(url).endsWith('/credentials'))return new Response(JSON.stringify({id:'card-committed',number:'4242424242424242',cvc:'123',exp_month:'12',exp_year:'2030'}));
 if(String(url).endsWith('/card-committed'))return new Response(JSON.stringify(card));
 assert.ok(String(url).endsWith('/cards'));
 const key=new Headers(init.headers).get('idempotency-key');creates.push({key,body:JSON.parse(init.body)});
 if(!cards.has(key))cards.set(key,card);
 if(state.stage===5)return new Response(JSON.stringify(card));
 throw new DOMException('Provider committed the card, response lost','TimeoutError');
},()=>({baseUrl:'https://mock.invalid',clientId:'client',clientSecret:'secret'}),{now:()=>now,sleep:async ms=>{now+=ms;}});
const provider=new AgentCardV2Provider('usr-owned',api.request);
const wallet={fundUserWallet:async()=>({}),confirmCollection:async()=>({}),reclaimUserWalletFunding:async()=>{throw new Error('unknown transfer must not be reclaimed');}};
state.purchase={id:'review-purchase',userId:'review-user',agentId:null,cardId:null,stripePaymentIntentId:null,
 stripeLivemode:false,status:'CHARGING',totalCents:100,stripeCustomerId:'cus-test',stripeSubscriptionId:'sub-test'};
const input={userId:'review-user',merchant:'Test merchant',totalCents:100,fingerprint:'stable-fingerprint'};
const mint=async()=>{try{return await chargeAndIssueCard(state.purchase,input,'cus-test',provider,wallet);}catch(error){return error;}};
(async()=>{
 if(scenario==='first-wrong-mode'||scenario==='first-no-method'||scenario==='first-decline'){
  state.stage=scenario==='first-wrong-mode'?3:scenario==='first-no-method'?2:4;
  const failure=await mint();
  assert.notEqual(failure.code,'agentcard_company_funding_in_progress');
  assert.equal(cards.size,0);assert.equal(state.funding,null);assert.equal(state.purchase.status,'FAILED');
  assert.equal(state.events.filter(e=>e.kind==='stripe-reverse').length,scenario==='first-wrong-mode'?1:0);
  assert.equal(state.events.filter(e=>e.kind==='stripe-capture').length,0);
  return;
 }
 const first=await mint();
 assert.equal(first.code,'agentcard_company_funding_in_progress');
 assert.equal(state.purchase.status,'FUNDING_PENDING');assert.ok(state.funding);
 assert.equal(cards.size,1);assert.equal(creates.length,3);
 assert.deepEqual([...new Set(creates.map(c=>c.key))],['purchase:review-purchase']);
 assert.equal(state.events.filter(e=>e.kind==='stripe-reverse').length,0);
 state.stage=scenario==='wrong-mode'?3:scenario==='stripe-decline'?4:2;
 const second=await mint();
 assert.ok(state.funding,'retry failure must retain the prior ambiguous provider obligation marker');
 assert.equal(second.code,'agentcard_company_funding_in_progress');
 assert.equal(state.purchase.id,'review-purchase');assert.equal(state.purchase.stripePaymentIntentId,'pi-preserved');
 assert.equal(state.purchase.status,'FUNDING_PENDING','same durable purchase must stay resumable');
 assert.equal(state.events.filter(e=>e.kind==='stripe-reverse').length,0,'uncertain prior mint must keep the backing hold');
 assert.equal(state.events.filter(e=>e.kind==='stripe-capture').length,0);
 assert.equal(creates.length,3,'retry failure must not mint a card in the wrong mode or after a billing refusal');
 state.stage=5;
 const recovered=await mint();
 assert.equal(recovered.purchaseId,'review-purchase',recovered.stack||JSON.stringify(recovered));assert.equal(recovered.cardId,'card-committed');
 assert.equal(state.purchase.status,'HELD');assert.equal(state.funding.id,'funding-one');
 assert.equal(state.funding.providerTransferId,'owt-committed');assert.equal(cards.size,1);
 assert.equal(state.events.filter(e=>e.kind==='stripe-capture').length,1);
 assert.equal(state.events.filter(e=>e.kind==='stripe-reverse').length,0);
 assert.deepEqual([...new Set(creates.map(c=>c.key))],['purchase:review-purchase']);
 assert.ok(creates.every(c=>c.body.user_id==='usr-owned'&&c.body.amount_cents===100));
 assert.deepEqual([...new Set(state.events.filter(e=>e.kind==='stripe-authorize').map(e=>e.key))],['purchase-charge:review-purchase']);
 process.stdout.write(JSON.stringify({scenario,providerCards:cards.size,purchase:state.purchase.status,
  cardKey:creates[0].key,stripeKey:'purchase-charge:review-purchase',fundingId:state.funding.id,
  providerAttempts:creates.length,captures:1,reversals:0})+'\n');
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
`;
  try {
    for (const scenario of [
      'preprovider',
      'wrong-mode',
      'stripe-decline',
      'first-wrong-mode',
      'first-no-method',
      'first-decline',
    ]) {
      const result = spawnSync(
        process.execPath,
        ['--require', guard, '--import', 'tsx', '--eval', probe],
        {
          cwd: backendDir,
          encoding: 'utf8',
          timeout: 15_000,
          env: { ...process.env, OBLIGATION_SCENARIO: scenario },
        }
      );
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, `${scenario}: ${result.stdout}\n${result.stderr}`);
      process.stdout.write(result.stdout);
    }
    process.stdout.write(
      'PASS prior funding obligation survives retry failures; first-attempt safe refusals compensate\n'
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
