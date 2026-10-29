import assert from 'node:assert/strict';
import { completionAnswerText } from '../../domains/agents/finalPresentation';
import { deliverNotificationMessage } from '../../providers/smsSupervisor/notificationDelivery';
import { buildCompletionSmsBody } from '../../providers/smsSupervisor/outboundEvents';

async function main() {
 const payload={presentation:{version:1,mode:'value',field:'day',encoding:'text'},answerText:'4',outputs:[{key:'day',value:4}]};
 assert.equal(completionAnswerText(payload),'4');
 assert.equal(completionAnswerText({...payload,answerText:'4.0'}),'4.0');
 assert.throws(()=>completionAnswerText({...payload,answerText:'4junk'}));
 assert.equal(completionAnswerText({...payload,presentation:{...payload.presentation,encoding:'json'},answerText:'4.0'}),'4.0');
 assert.equal(buildCompletionSmsBody('agent','Old report',payload.outputs,completionAnswerText(payload)),'4');
 assert.throws(()=>completionAnswerText({...payload,answerText:'5'}));
 assert.equal(completionAnswerText({outputs:payload.outputs}),undefined);
 let calls=0;
 const accepted=await deliverNotificationMessage({channel:'SMS',message:'4',requiredLinks:[],preserveText:true,
   send:async text=>{calls++;assert.equal(text,'4');return {success:true};}});
 assert.equal(accepted.message,'4');assert.equal(calls,1);
 calls=0;
 const rejected=await deliverNotificationMessage({channel:'SMS',message:'4',requiredLinks:[],preserveText:true,
   send:async()=>{calls++;return {success:false,definitiveFailure:true,statusCode:400,error:'rejected'};}});
 assert.equal(rejected.success,false);assert.equal(rejected.message,'4');assert.equal(calls,1);
 const report=await deliverNotificationMessage({channel:'SMS',message:'Legacy report',requiredLinks:[],send:async text=>({success:text==='Legacy report'})});
 assert.equal(report.message,'Legacy report');
 console.log('final presentation delivery PASS');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
