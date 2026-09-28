import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard } from '../src/web.ts';
import type { Task } from '../src/engine.ts';

const task = {
  id:1,source:'告警<script>x</script>',eventId:'event-1',groupId:'g',ownerIds:['owner'],status:'awaiting_owner',planVersion:2,
  waitStage:'initial',waitUntil:Date.UTC(2026,8,28,2),runId:null,runFence:0,runDeadline:null,noProgress:0,branch:null,
  mrUrl:'https://git.example/mr/1',mrState:'open',headSha:null,conclusion:null,blockReason:null,createdAt:0,updatedAt:Date.UTC(2026,8,28,1),completedAt:null,
  plan:{version:2,body:JSON.stringify({background:'背景 <img src=x>',diagnosis:'超时',evidence:['日志 A','<script>bad</script>'],scope:['服务 A'],solution:'修复共享入口',acceptance:['检查通过'],risks:['回滚风险']}),notifiedAt:null,reminderSentAt:null,notificationMessageId:null,reminderMessageId:null},
} satisfies Task;
const noCodeTask = {...task,id:2,status:'no_code_wait',planVersion:0,plan:undefined,conclusion:JSON.stringify({summary:'上游已恢复',evidence:['恢复日志'],tests:['连续检查通过'],noCodeChange:true,externalAction:'确认关闭'})} as Task;

async function withServer(run: (base: string) => Promise<void>) {
  const server=createDashboard(()=>[task,noCodeTask],{phoenixUrl:'https://trace.example',getReport:current=>current.id===2?{summary:'上游已恢复',evidence:['恢复日志'],tests:['连续检查通过'],externalAction:'确认关闭'}:{summary:'中文摘要',background:'背景 <img src=x>',diagnosis:'超时',evidence:['日志 A','<script>bad</script>'],scope:['服务 A'],solution:'修复共享入口',acceptance:['检查通过'],risks:['回滚风险'],displayNote:'中文展示；原始方案版本未变'}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
}

test('dashboard links to the current task report with Chinese status', async () => withServer(async base => {
  const response=await fetch(base+'/');
  const html=await response.text();
  assert.equal(response.status,200);
  assert.match(html,/href="\/tasks\/1\?version=2"/);
  assert.match(html,/等待 Owner 确认/);
  assert(!html.includes('<script>x</script>'));
}));

test('task report is sectioned, escaped, read-only, and version-bound', async () => withServer(async base => {
  const response=await fetch(base+'/tasks/1?version=2');
  const html=await response.text();
  assert.equal(response.status,200);
  for (const heading of ['摘要','背景','诊断','证据','影响范围','解决方案','验收标准','风险']) assert.match(html,new RegExp(`<h2>${heading}</h2>`));
  assert.match(html,/中文展示；原始方案版本未变/);
  assert.match(html,/2026年9月28日 10:00/);
  assert.match(html,/查看 MR/);
  assert(!html.includes('<script>bad</script>'));
  assert(!html.includes('<img src=x>'));
  assert.equal((await fetch(base+'/tasks/1?version=1')).status,409);
  assert.equal((await fetch(base+'/tasks/999?version=2')).status,404);
  assert.equal((await fetch(base+'/tasks/1?version=2',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/tasks/1?version=2',{method:'HEAD'})).status,200);
}));

test('no-code completion is rendered as a readable report at version zero', async () => withServer(async base => {
  const response=await fetch(base+'/tasks/2?version=0');
  const html=await response.text();
  assert.equal(response.status,200);
  assert.match(html,/<h2>处理结论<\/h2>/);
  assert.match(html,/上游已恢复/);
  assert.match(html,/恢复日志/);
  assert.match(html,/连续检查通过/);
  assert(!html.includes('"noCodeChange"'));
}));
