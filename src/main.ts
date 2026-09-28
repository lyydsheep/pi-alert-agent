import AiBot from '@wecom/aibot-node-sdk';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { PiRunner } from './pi/index.ts';
import { GitWorkspaceManager } from './git.ts';
import { GitLabDeliveryClient } from './delivery.ts';
import { AlertService } from './service.ts';
import { incomingFrame, sendGroup } from './wecom.ts';
import { createDashboard } from './web.ts';
import { createObserver } from './observability.ts';
import { acquireServiceLock } from './lock.ts';

const config=loadConfig(process.argv[2]??'config.local.json');
const releaseLock=await acquireServiceLock(config.dataDir);
let exiting=false;
const observer=config.phoenix?createObserver({endpoint:config.phoenix.endpoint,apiKey:config.phoenix.apiKey}):undefined;
const service=new AlertService(config,{
  runner:new PiRunner({agentDir:join(config.dataDir,'pi'),model:config.model,timeoutMs:config.runTimeoutMs,tools:config.tools,skills:config.skills}),
  git:new GitWorkspaceManager({repositoryPath:config.repositoryPath,worktreeRoot:join(config.dataDir,'worktrees'),targetBranch:'master'}),
  delivery:new GitLabDeliveryClient(config.delivery),
  notify:async(groupId,text,owners)=>{const group=config.groups[groupId];if(!group)throw new Error('Unknown notification group');await sendGroup(group.webhook,text,owners);},
  trace:(taskId,runId,event)=>observer?.event(taskId,runId,event),
});
service.engine.recoverRuns();
const web=createDashboard(()=>service.engine.listTasks(),{phoenixUrl:config.phoenix?.publicUrl});
await new Promise<void>((resolve,reject)=>{web.once('error',reject);web.listen(config.port,config.host,resolve);});
const bot=new AiBot.WSClient({botId:config.bot.id,secret:config.bot.secret,maxReconnectAttempts:-1,
  logger:{debug:()=>{},info:()=>{},warn:(message:string)=>console.warn(message),error:(message:string)=>console.error(message)}});
// Serialize inbound mutations; model work remains independently concurrent.
let inbound:Promise<void>=Promise.resolve();
bot.on('message.text',frame=>{inbound=inbound.then(async()=>{
  const message=incomingFrame(frame,config.bot.mention);
  console.log('Bot text received:',JSON.stringify({configuredGroup:!!config.groups[message.groupId]}));
  await service.receive(message);
}).catch(error=>console.error('Inbound processing failed:',error instanceof Error?error.message:'unknown'));});
for(const event of ['authenticated','disconnected','reconnecting'] as const)bot.on(event,()=>console.log(new Date().toISOString(),`Bot ${event}`));
bot.on('error',error=>console.error('Bot connection error:',error instanceof Error?error.message:'unknown'));
bot.connect();
const interval=setInterval(()=>void service.pump().catch(error=>console.error('Scheduler failed:',error instanceof Error?error.message:'unknown')),1000);
console.log(`Read-only dashboard: http://${config.host}:${config.port}`);
const stop=async()=>{
  if(exiting)return;exiting=true;clearInterval(interval);bot.disconnect();
  await inbound;await service.shutdown();
  await new Promise<void>(resolve=>web.close(()=>resolve()));await observer?.close();service.store.close();await releaseLock();
};
process.on('SIGTERM',()=>void stop().catch(()=>{process.exitCode=1;}));
process.on('SIGINT',()=>void stop().catch(()=>{process.exitCode=1;}));
