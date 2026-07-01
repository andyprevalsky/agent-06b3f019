import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main(){
  const id='da938195-9fd0-4c2e-b1b8-202936a34121';
  const kids = await prisma.agent.findMany({ where:{ parentAgentId:id }, select:{ id:true,status:true,createdAt:true,updatedAt:true } , orderBy:{createdAt:'asc'}});
  console.log('DIRECT CHILDREN:', kids.length);
  // concurrency by created/updated window
  for (const k of kids.slice(0,6)) console.log(' ', k.id, k.status, k.createdAt.toISOString());
  const ids = kids.map(k=>k.id);
  let total = kids.length, frontier = ids, depth=1;
  while(frontier.length && depth<6){
    const next = await prisma.agent.findMany({ where:{ parentAgentId:{ in: frontier } }, select:{id:true} });
    if(!next.length) break;
    console.log(`  depth ${depth+1}: +${next.length}`);
    total += next.length; frontier = next.map(n=>n.id); depth++;
  }
  console.log('TOTAL DESCENDANTS:', total);
  // status breakdown of direct children
  const byStatus:Record<string,number>={};
  for(const k of kids) byStatus[k.status]=(byStatus[k.status]||0)+1;
  console.log('child status:', byStatus);
  process.exit(0);
}
main().catch(e=>{console.error(e.message);process.exit(1)});
