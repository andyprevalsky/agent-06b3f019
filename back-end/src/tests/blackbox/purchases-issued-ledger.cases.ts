import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Default cleanup/compensation orchestration; only persistence and external boundaries injected. */
export function assertIssuedLedgerCleanup(backendDir: string): void {
  const folder = mkdtempSync(path.join(tmpdir(), 'paid-cleanup-'));
  const guard = path.join(folder, 'preload.cjs');
  writeFileSync(
    guard,
    String.raw`
const Module=require('node:module'),path=require('node:path');
const localRequire=Module.createRequire(path.join(process.cwd(),'package.json'));
const put=(rel,value)=>{const id=localRequire.resolve(path.join(process.cwd(),'src',rel));const m=new Module(id);m.loaded=true;m.exports=value;require.cache[id]=m;};
global.fetch=async()=>{throw new Error('UNEXPECTED_VENDOR_CALL');};
require('node:net').Socket.prototype.connect=()=>{throw new Error('UNEXPECTED_REAL_NETWORK');};
const scenario=process.env.LEDGER_CLEANUP_SCENARIO;
const s=global.__cleanup={calls:{close:0,reclaim:0,reverse:0,mint:0,locks:0},reads:[],purchase:{id:'purchase-1',userId:'rose-owned',agentId:'agent-1',cardId:'card-owned',totalCents:4396,merchant:'Test Shop',stripeLivemode:false,stripePaymentIntentId:'pi-owned',status:scenario==='refund-retry'?'REFUND_FAILED':['held','held-empty','unspent','dissolved'].includes(scenario)?'HELD':['abandoned','abandoned-empty'].includes(scenario)?'FUNDING_ABANDONED':scenario==='retry'?'FUNDING_RECLAIM_FAILED':scenario==='pending-issued'?'FUNDING_PENDING':'CHARGING',updatedAt:new Date(0)},funding:{id:'funding-1',purchaseId:'purchase-1',userId:'rose-owned',amountCents:4396,currency:'usd',providerTransferId:'owt-owned',status:scenario==='refund-retry'?'RECLAIMED':scenario==='retry'?'RECLAIMING':'FUNDED',metadata:{apiVersion:2},updatedAt:new Date(0)}};
if(['retry-empty','retry-released'].includes(scenario)){s.purchase.status='FUNDING_RECLAIM_FAILED';s.funding.status='RECLAIM_FAILED';}
const replayMode=scenario==='abandoned-unissued-live'?true:scenario==='abandoned-unissued-test'?false:null;
if(replayMode!==null){s.purchase.cardId=null;s.purchase.stripeLivemode=replayMode;s.purchase.status='FUNDING_ABANDONED';}
const row=()=>({...s.purchase,walletFunding:s.funding});
function matches(where,obj){if(!where)return true;return Object.entries(where).every(([k,v])=>{
 if(k==='OR')return v.some(w=>matches(w,obj));if(k==='AND')return v.every(w=>matches(w,obj));
 const a=obj[k];if(v&&typeof v==='object'&&!(v instanceof Date)){
 if('in'in v)return v.in.includes(a);if('not'in v)return a!==v.not;
 if('lt'in v)return a<v.lt;if('lte'in v)return a<=v.lte;if('is'in v)return matches(v.is,a);return matches(v,a);
 }return v instanceof Date?a?.getTime()===v.getTime():a===v;});}
const model=kind=>({findUnique:async()=>kind==='purchase'?row():s.funding,findUniqueOrThrow:async()=>kind==='purchase'?row():s.funding,
 findFirst:async a=>matches(a.where,row())?row():null,findMany:async a=>matches(a.where,row())?[row()]:[],
 updateMany:async a=>{const obj=kind==='purchase'?s.purchase:s.funding;if(scenario==='cas-lost'&&kind==='purchase')return {count:0};if(!matches(a.where,obj))return {count:0};Object.assign(obj,a.data);return{count:1};},
 update:async a=>{const obj=kind==='purchase'?s.purchase:s.funding;Object.assign(obj,a.data);return obj;}});
const db={purchaseSpend:model('purchase'),purchaseWalletFunding:model('funding'),$executeRaw:async()=>{s.calls.locks++;}};
db.$transaction=async fn=>{const p={...s.purchase},f={...s.funding};try{return await fn(db);}catch(e){Object.assign(s.purchase,p);Object.assign(s.funding,f);throw e;}};put('providers/database.ts',{prisma:db,runTransactionWithRetry:fn=>db.$transaction(fn)});
put('providers/stripe.ts',{reversePurchasePaymentIntent:async()=>{s.calls.reverse++;return 'refunded';},getStripeClientForLivemode:()=>({paymentIntents:{retrieve:async()=>({status:scenario==='dissolved'?'canceled':'succeeded'}),search:async()=>{throw new Error('unexpected Stripe search');}}})});
const card=global.__card={getDetails:async()=>({status:'CLOSED',balanceCents:0}),closeCard:async()=>{s.calls.close++;},mintCard:async request=>{s.calls.mint++;if(replayMode!==null){require('node:assert/strict').equal(request.expectedLivemode,replayMode,'compensation must preserve persisted purchase mode');require('node:assert/strict').equal(request.idempotencyKey,'purchase:purchase-1');require('node:assert/strict').equal(request.amountCents,4396);require('node:assert/strict').equal(request.fundsSource,'company_flow');const {AgentCardProviderError}=localRequire('./src/providers/card-provider/errors.ts');throw new AgentCardProviderError('Owned terminal mint',502,undefined,'agentcard_card_creation_failed');}throw new Error('must not remint');}};
put('providers/card-provider/index.ts',{isCardLive:d=>d.status==='active'||d.status==='open',createCardProviderForAgent:async()=>card});
put('providers/purchase-wallet-funding.ts',{
 beginPurchaseWalletReclaim:async()=>{s.funding.status='RECLAIMING';return{status:'owned',reclaimLeaseToken:'lease'};},
 reclaimPurchaseWalletFunding:async()=>{s.calls.reclaim++;s.funding.status='RECLAIMED';},
 consumePurchaseWalletFunding:async()=>{s.funding.status='CONSUMED';},
 discardPendingPurchaseWalletCollection:async()=>{if(replayMode!==null)return;throw new Error('unexpected discard');},recordIssuedPurchaseCardFunding:async()=>{throw new Error('unexpected persistence replay');}
});
put('providers/purchase-wallet-funding-repo.ts',{findWalletFundingByPurchaseId:async()=>s.funding,lockPurchaseWalletTransition:async()=>{s.calls.locks++;if(scenario==='race-lease')s.funding.status='RECLAIMING';},claimWalletFundingReclaimRetry:async()=>({count:1})});
put('providers/agentcard/wallet-v2.ts',{getV2WalletOwnerId:async()=>scenario==='unknown-owner'?undefined:'usr-owned'});
put('providers/agentcard/api-v2.ts',{agentCardV2Request:async(method,url)=>{
 s.reads.push({method,url});if(scenario==='api-error')throw Object.assign(new Error('sensitive provider body must never be logged'),{code:'ECONNRESET'});if(method!=='GET')throw new Error('financial API write');
 if(url==='/api/v2/company_wallet')return{livemode:scenario==='wrong-mode'};
 if(url==='/api/v2/company_wallet/transfers/owt-owned')return{id:'owt-owned',user_id:scenario==='transfer-foreign'?'usr-foreign':'usr-owned',card_id:'card-owned',livemode:false,amount_cents:4396,released_cents:['unspent','retry-released'].includes(scenario)?4396:0,status:['unspent','retry-released'].includes(scenario)?'reclaimed':'consumed'};
 if(url==='/api/v2/cards/card-owned')return{id:'card-owned',user_id:scenario==='card-foreign'?'usr-foreign':'usr-owned',status:'closed',balance_cents:0};
 if(!url.startsWith('/api/v2/transactions?'))throw new Error('unexpected API path '+url);
 const q=new URLSearchParams(url.split('?')[1]);if(q.get('card_id')!=='card-owned'||q.get('user_id')!=='usr-owned')throw new Error('wrong ledger scope');
 return{object:'list',has_more:scenario==='incomplete',data:['empty','held-empty','abandoned-empty','unspent','retry-empty','retry-released'].includes(scenario)?[]:[{id:'txn-cleared',object:'transaction',source:'issued',status:scenario==='refund-retry'?'voided':scenario==='pending'?'pending':'cleared',card_id:scenario==='foreign'?'card-other':'card-owned',user_id:scenario==='ledger-foreign'?'usr-foreign':'usr-owned',amount:scenario==='partial'?2000:4396,merchant:'Test Shop',currency:'usd'}]};
}});
`
  );
  const probe = String.raw`
const assert=require('node:assert/strict');
const {cleanupAgentPurchaseCards,reconcileStaleChargingPurchases,reconcileAbandonedPurchaseFunding,reconcileFailedPurchaseFundingReclaims,reconcileDissolvedPurchaseHolds,reconcileFailedPurchaseRefunds}=require('./src/providers/purchaseCleanup.ts');
const s=global.__cleanup;const scenario=process.env.LEDGER_CLEANUP_SCENARIO;const initial=s.purchase.status;
(async()=>{
 if(scenario==='refund-retry')await reconcileFailedPurchaseRefunds({agentId:'agent-1'});
 else if(['held','held-empty','pending-issued','unspent'].includes(scenario))await cleanupAgentPurchaseCards('agent-1',global.__card,{});
 else if(['abandoned','abandoned-empty','abandoned-unissued-test','abandoned-unissued-live'].includes(scenario))await reconcileAbandonedPurchaseFunding(global.__card,{}, {agentId:'agent-1'});
 else if(['retry','retry-empty','retry-released'].includes(scenario))await reconcileFailedPurchaseFundingReclaims({}, {agentId:'agent-1'},global.__card);
 else if(scenario==='dissolved')await reconcileDissolvedPurchaseHolds(global.__card,{}, {agentId:'agent-1'});
 else await reconcileStaleChargingPurchases({}, {agentId:'agent-1'});
 if(['abandoned-unissued-test','abandoned-unissued-live'].includes(scenario)){assert.equal(s.purchase.status,'FAILED','terminal mint must compensate after exact mode-bound replay');assert.equal(s.calls.mint,1);assert.equal(s.calls.reverse,1);assert.equal(s.calls.close,0);assert.equal(s.calls.reclaim,0);assert.equal(s.reads.length,0);console.log(JSON.stringify({scenario,purchase:s.purchase.status,sideEffects:s.calls}));return;}
 if(scenario==='refund-retry'){assert.equal(s.purchase.status,'REFUNDED');assert.equal(s.funding.status,'RECLAIMED');assert.equal(s.calls.reverse,1);assert.equal(s.calls.reclaim,0);assert.equal(s.calls.close,0);assert.equal(s.reads.length,0);console.log(JSON.stringify({scenario,purchase:s.purchase.status,funding:s.funding.status,sideEffects:s.calls}));return;}
 if(['spent','held','abandoned','pending-issued','dissolved'].includes(scenario)){
  assert.equal(s.purchase.status,scenario==='dissolved'?'CAPTURE_FAILED':'CLEARED','exact cleared issued ledger must prevent abandonment');
  assert.equal(s.funding.status,'CONSUMED');assert.equal(s.calls.locks,1);
 }else if(['unspent','retry-released'].includes(scenario)){
  assert.equal(s.purchase.status,'VOIDED');assert.equal(s.funding.status,'RECLAIMED');
  assert.equal(s.calls.close,1);assert.equal(s.calls.reclaim,1);assert.equal(s.calls.reverse,1);console.log(JSON.stringify({scenario,purchase:s.purchase.status,funding:s.funding.status,sideEffects:s.calls}));return;
 }else{
  assert.equal(s.purchase.status,initial,'ambiguous evidence must preserve durable obligation');
  assert.equal(s.funding.status,['retry','race-lease'].includes(scenario)?'RECLAIMING':scenario==='retry-empty'?'RECLAIM_FAILED':'FUNDED');
 }
 assert.equal(s.calls.close,0);assert.equal(s.calls.reclaim,0);assert.equal(s.calls.reverse,0);assert.equal(s.calls.mint,0);
 const first=JSON.stringify(s.calls);
 if(['spent','held','abandoned','pending-issued','dissolved'].includes(scenario))await cleanupAgentPurchaseCards('agent-1',global.__card,{});
 assert.equal(JSON.stringify(s.calls),first,'duplicate cleanup must not repeat financial work');
 console.log(JSON.stringify({scenario,purchase:s.purchase.status,funding:s.funding.status,sideEffects:s.calls,readCount:s.reads.length}));
})().catch(e=>{console.error(JSON.stringify({scenario,purchase:s.purchase.status,funding:s.funding.status,sideEffects:s.calls}));console.error(e.stack);process.exitCode=1;});
`;
  try {
    for (const scenario of [
      'abandoned-unissued-test',
      'abandoned-unissued-live',
      'retry-empty',
      'retry-released',
      'spent',
      'held',
      'abandoned',
      'empty',
      'pending',
      'partial',
      'foreign',
      'incomplete',
      'wrong-mode',
      'unknown-owner',
      'retry',
      'unspent',
      'refund-retry',
      'api-error',
      'cas-lost',
      'held-empty',
      'abandoned-empty',
      'pending-issued',
      'dissolved',
      'transfer-foreign',
      'card-foreign',
      'ledger-foreign',
      'race-lease',
    ]) {
      if (process.env.LEDGER_CLEANUP_ONLY && process.env.LEDGER_CLEANUP_ONLY !== scenario) continue;
      const result = spawnSync(
        process.execPath,
        ['--require', guard, '--import', 'tsx', '--eval', probe],
        {
          cwd: backendDir,
          encoding: 'utf8',
          timeout: 15_000,
          env: { ...process.env, LEDGER_CLEANUP_SCENARIO: scenario },
        }
      );
      assert.ok(
        !result.stdout.includes('sensitive provider body'),
        'evidence errors must not log raw provider bodies'
      );
      assert.equal(result.status, 0, `${scenario}: ${result.stdout}\n${result.stderr}`);
      process.stdout.write(result.stdout);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
