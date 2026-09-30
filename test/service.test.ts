import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { Config } from '../src/config.ts';
import type { DeliveryStatus, MergeRequest, MergeRequestFeedback } from '../src/delivery.ts';
import { GitWorkspaceConflictError, type GitWorkspace, type PushResult } from '../src/git.ts';
import type { PiRunInput, PiRunResult } from '../src/pi/index.ts';
import { AlertService, type ServiceDependencies } from '../src/service.ts';
import { Store } from '../src/store.ts';
import type { IncomingMessage } from '../src/wecom.ts';

const repairPlan = {
  background: 'request timeout alert', diagnosis: 'lease is ignored', evidence: ['trace-1'],
  scope: ['worker'], solution: 'honor the lease', acceptance: ['test passes'], risks: ['earlier cancellation'],
};

function result(input: PiRunInput, kind: 'plan' | 'fixed' | 'no-code'): PiRunResult {
  const metadata = {
    taskId: input.taskId, runId: input.runId, sessionId: `session-${input.taskId}`,
    durationMs: 1, summary: kind, progressKey: `${kind}-${input.taskId}`, progress: true,
  };
  if (kind === 'plan') return { ...metadata, status: 'plan', plan: repairPlan };
  return {
    ...metadata, status: 'completed', completion: {
      summary: kind === 'fixed' ? 'fixed' : 'upstream recovered', evidence: ['trace-1'],
      changedFiles: kind === 'fixed' ? ['worker.ts'] : [], tests: ['worker test'], noCodeChange: kind === 'no-code',
    },
  };
}

function message(messageId: string, text: string, senderId = 'bot', quote = ''): IncomingMessage {
  return { messageId, groupId: 'group', senderId, text, quote };
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function eventually(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await immediate();
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function fixture(t: TestContext, run: (input: PiRunInput) => Promise<PiRunResult>, concurrency = 4) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-alert-service-'));
  const store = new Store(join(directory, 'state.sqlite'));
  let now = 1_000_000;
  const notifications: Array<{ groupId: string; text: string; owners: string[] }> = [];
  const calls = { prepare: 0, push: 0, createMr: 0, status: 0, cleanup: 0, ensureAgentReview: [] as Array<{mrIid:number;head:string}> };
  let feedback: MergeRequestFeedback[] = [];
  let deliveryStatus: DeliveryStatus = {
    mergeRequest: { iid: 7, url: 'https://git.test/mr/7', state: 'opened', sourceBranch: 'fix/faizili_1', targetBranch: 'master', head: 'head-1' },
    currentHead: true, agentReviewPassed: true, agentReviewStatus:'success', mergeable:true, checks: { build: 'success' }, ownerRequired: false, complete: true,
  };
  const workspace = (taskId: string): GitWorkspace => ({
    taskId, path: join(directory, 'worktrees', taskId), branch: `fix/faizili_${taskId}`, head: 'base', resumed: false,
  });
  const deps: ServiceDependencies = {
    runner: { run },
    git: {
      prepare: async (taskId) => { calls.prepare++; return workspace(taskId); },
      push: async (): Promise<PushResult> => { calls.push++; return { head: 'head-1', alreadyPresent: false }; },
      status: async () => '',
      head: async () => 'head-1',
      cleanup: async () => { calls.cleanup++; return false; },
    },
    delivery: {
      createOrReadMergeRequest: async (): Promise<MergeRequest> => { calls.createMr++; return deliveryStatus.mergeRequest; },
      status: async () => { calls.status++; return deliveryStatus; },
      ensureAgentReview: async (mrIid,head) => { calls.ensureAgentReview.push({mrIid,head}); },
      feedback: async (): Promise<MergeRequestFeedback[]> => feedback,
    },
    notify: async (groupId, text, owners) => { notifications.push({ groupId, text, owners }); },
    now: () => now,
  };
  const config: Config = {
    dataDir: directory, repositoryPath: directory, host: '127.0.0.1', port: 8080,
    concurrency, waitMs: 30 * 60_000, runTimeoutMs: 60 * 60_000,
    groups: { group: { owners: ['owner'], webhook: 'https://example.test/hook' } },
    bot: { id: 'bot', secret: 'secret' }, model: { provider: 'test', id: 'test', apiKey: 'test' },
    delivery: { apiEndpoint: 'https://git.test/api/v4', token: 'token', project: 'p', requiredChecks: ['build'], agentReviewCheck: 'Agent Review' },
  };
  const service = new AlertService(config, deps, store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    service, store, notifications, calls,
    advance: (ms: number) => { now += ms; },
    setDeliveryStatus: (value: DeliveryStatus) => { deliveryStatus = value; },
    setFeedback: (value: MergeRequestFeedback[]) => { feedback = value; },
  };
}

test('ambiguous Owner targets are rejected and quoted alert context is retained',async t=>{
  const f=fixture(t,async input=>result(input,'plan'));
  await f.service.receive(message('quoted-alert','排查 失败','owner','[告警:alerts:original] 原始日志与详情'));
  assert.match(f.service.engine.events(1)[0].text,/原始日志与详情/);
  await f.service.receive(message('other-alert','[告警:alerts:other] down'));
  await f.service.pump();
  await eventually(()=>f.service.engine.listTasks().every(task=>task.status==='plan_notify_pending'),'both plans');
  await f.service.pump();
  const before=f.service.engine.listTasks().map(task=>task.status);
  await f.service.receive(message('ambiguous','任务 #2 同意','owner','[告警方案:1:1]'));
  assert.deepEqual(f.service.engine.listTasks().map(task=>task.status),before);
  assert.match(f.notifications.at(-1)!.text,/冲突|不一致/);
  await f.service.receive(message('ambiguous-alert','任务 #2 同意','owner','[告警:alerts:original]'));
  assert.deepEqual(f.service.engine.listTasks().map(task=>task.status),before);
  await f.service.receive(message('approve-quoted-alert','同意','owner','[告警:alerts:original]'));
  assert.equal(f.service.engine.getTask(1)?.status,'ready');
  assert.equal(f.service.engine.getTask(2)?.status,before[1]);
  await f.service.receive(message('same-alert','排查 再看一次','owner','[告警:alerts:original] 原始日志与详情'));
  assert.equal(f.service.engine.listTasks().length,2);
});

test('same-HEAD pending and conflicts revoke delivery before a queued completion notice',async t=>{
  const f=fixture(t,async input=>result(input,input.phase==='investigate'?'plan':'fixed'));
  await f.service.receive(message('rollback-alert','[告警:alerts:rollback] down'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='plan_notify_pending','plan');
  await f.service.pump();await f.service.receive(message('rollback-approve','任务 #1 同意','owner'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='awaiting_checks','MR');
  for(const conflict of [false,true]){
    if(conflict)f.setFeedback([{id:1,body:'[change-request] inspect build',classification:'change-request'}]);
    f.service.engine.recordMrChecks({taskId:1,headSha:'head-1',agentReview:'passed',requiredChecks:['passed']});
    f.setDeliveryStatus({mergeRequest:{iid:7,url:'https://git.test/mr/7',state:'opened',sourceBranch:'fix/faizili_1',targetBranch:'master',head:'head-1'},
      currentHead:true,agentReviewPassed:true,agentReviewStatus:'success',checks:{build:conflict?'failed':'pending'},mergeable:!conflict,ownerRequired:conflict,complete:false});
    f.advance(30_000);await f.service.pump();
    assert.equal(f.service.engine.getTask(1)?.status,'awaiting_checks');
    assert.equal(f.service.engine.getTask(1)?.completedAt,null);
    if(conflict)assert.equal(f.store.get<{feedback_id:number}>('SELECT feedback_id FROM runtime WHERE task_id=1')?.feedback_id,0);
  }
  assert.ok(!f.notifications.some(n=>n.text.includes('修复交付完成')));
  assert.ok(f.notifications.some(n=>n.text.includes('存在冲突')));
  f.setFeedback([]);
  f.setDeliveryStatus({mergeRequest:{iid:7,url:'https://git.test/mr/7',state:'opened',sourceBranch:'fix/faizili_1',targetBranch:'master',head:'head-1'},
    currentHead:true,agentReviewPassed:false,agentReviewStatus:'pending',checks:{build:'failed'},mergeable:false,
    ownerRequired:true,ownerGate:'approval',ownerAction:'请完成人工审批',complete:false});
  f.advance(30_000);await f.service.pump();
  assert.equal(f.service.engine.getTask(1)?.status,'queued','failed CI repairs proceed without first approving broken code');
  assert.ok(f.calls.ensureAgentReview.some(r=>r.head==='head-1'),'approval gate does not suppress Agent review');
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='awaiting_checks','CI repair');
  f.setFeedback([{id:1,body:'[change-request] inspect build',classification:'change-request'}]);
  f.setDeliveryStatus({mergeRequest:{iid:7,url:'https://git.test/mr/7',state:'opened',sourceBranch:'fix/faizili_1',targetBranch:'master',head:'head-1'},
    currentHead:true,agentReviewPassed:true,agentReviewStatus:'success',checks:{build:'success'},mergeable:false,
    ownerRequired:true,ownerGate:'discussion',ownerAction:'请处理评审讨论',complete:false});
  f.advance(30_000);await f.service.pump();
  assert.equal(f.service.engine.getTask(1)?.status,'queued','explicit review change requests remain actionable behind a discussion gate');
  assert.equal(f.store.get<{feedback_id:number}>('SELECT feedback_id FROM runtime WHERE task_id=1')?.feedback_id,1);
});

test('changing tool output does not reset no-progress when executor reports no meaningful progress',async t=>{
  let rounds=0;
  const f=fixture(t,async input=>{
    const value=result(input,input.phase==='investigate'?'plan':'fixed');
    if(input.phase==='execute'){
      input.onEvent?.({type:'tool_execution_end',toolName:'bash',isError:false,result:{content:[{type:'text',text:`timestamp ${++rounds}`}]}});
      value.progress=false;
    }
    return value;
  });
  const prepare=f.service.deps.git.prepare;
  f.service.deps.git.prepare=async(...args)=>({...await prepare(...args),head:'head-1'});
  const status=f.service.deps.delivery.status;
  f.service.deps.delivery.status=async(...args)=>({...await status(...args),agentReviewPassed:false,agentReviewStatus:'failed',complete:false});
  await f.service.receive(message('semantic-alert','[告警:alerts:semantic] down'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='plan_notify_pending','plan');
  await f.service.pump();await f.service.receive(message('semantic-approve','任务 #1 同意','owner'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='awaiting_checks','MR');
  for(let i=0;i<3;i++){
    f.advance(30_000);await f.service.pump();await f.service.pump();
    await eventually(()=>['awaiting_checks','blocked'].includes(f.service.engine.getTask(1)!.status),'retry');
  }
  assert.equal(f.service.engine.getTask(1)?.status,'blocked');
  assert.equal(f.service.engine.getTask(1)?.noProgress,3);
});

test('runs intake through approved fix, MR, current checks and delivery', async (t) => {
  const phases: string[] = [];
  const f = fixture(t, async (input) => {
    phases.push(input.phase);
    return result(input, input.phase === 'investigate' ? 'plan' : 'fixed');
  });

  await f.service.receive(message('m1', '[告警:alerts:event-1] request timeout'));
  await f.service.pump();
  await eventually(() => f.service.engine.getTask(1)?.status === 'plan_notify_pending', 'investigation plan');
  await f.service.pump();
  assert.equal(f.service.engine.getTask(1)?.status, 'awaiting_owner');

  await f.service.receive(message('m2', '任务 #1 同意', 'owner'));
  await f.service.pump();
  await eventually(() => f.service.engine.getTask(1)?.status === 'awaiting_checks', 'MR creation');
  assert.equal(f.calls.push, 1);
  assert.equal(f.calls.createMr, 1);

  f.advance(30_000);
  await f.service.pump();
  assert.equal(f.service.engine.getTask(1)?.status, 'delivered');
  await f.service.pump();
  assert.deepEqual(phases, ['investigate', 'execute']);
  assert.ok(f.notifications.some((notice) => notice.text.includes('修复交付完成（不代表线上恢复）')));
});

test('retries the durable MR notification after delivery failure', async (t) => {
  const f = fixture(t, async (input) => result(input, input.phase === 'investigate' ? 'plan' : 'fixed'));
  await f.service.receive(message('m1', '[告警:alerts:mr-notify] down'));
  await f.service.pump();
  await eventually(() => f.service.engine.getTask(1)?.status === 'plan_notify_pending', 'plan');
  await f.service.pump();
  await f.service.receive(message('m2', '任务 #1 同意', 'owner'));
  await f.service.pump();
  await eventually(() => f.service.engine.getTask(1)?.status === 'awaiting_checks', 'MR');

  const notify = f.service.deps.notify;
  let failed = false;
  f.service.deps.notify = async (groupId, text, owners) => {
    if (!failed && text.includes('已创建/更新 MR')) { failed = true; throw new Error('notification unavailable'); }
    await notify(groupId, text, owners);
  };
  const originalError = console.error;
  console.error = () => undefined;
  try { await f.service.pump(); } finally { console.error = originalError; }
  assert.equal(f.service.engine.outbox().filter((effect) => effect.type === 'notify_mr').length, 1);

  f.advance(2_000);
  await f.service.pump();
  assert.equal(f.service.engine.outbox().some((effect) => effect.type === 'notify_mr'), false);
  assert.equal(f.notifications.filter((notice) => notice.text.includes('已创建/更新 MR')).length, 1);
});

test('keeps no-code conclusion open until the Owner explicitly confirms', async (t) => {
  const f = fixture(t, async (input) => result(input, 'no-code'));
  await f.service.receive(message('m1', '[告警:alerts:no-code] recovered'));
  await f.service.pump();
  await eventually(() => f.service.engine.getTask(1)?.status === 'no_code_wait', 'no-code conclusion');
  await f.service.pump();
  assert.ok(f.notifications.some((notice) => notice.text.includes('无需代码修复')));

  f.advance(4 * 60 * 60_000);
  await f.service.pump();
  assert.equal(f.service.engine.getTask(1)?.status, 'no_code_wait');
  await f.service.receive(message('m2', '任务 #1 确认关闭', 'owner'));
  assert.equal(f.service.engine.getTask(1)?.status, 'closed');
});

test('defer resets the full wait and pause stops later timeout dispatch', async (t) => {
  const phases: string[] = [];
  const f = fixture(t, async (input) => { phases.push(input.phase); return result(input, 'plan'); });
  await f.service.receive(message('m1', '[告警:alerts:wait] wait'));
  await f.service.pump();
  await eventually(() => f.service.engine.getTask(1)?.status === 'plan_notify_pending', 'plan');
  await f.service.pump();
  const initialDeadline = f.service.engine.getTask(1)!.waitUntil!;

  f.advance(5 * 60_000);
  await f.service.receive(message('m2', '任务 #1 等一下', 'owner'));
  assert.ok(f.service.engine.getTask(1)!.waitUntil! > initialDeadline);
  f.advance(30 * 60_000);
  await f.service.pump();
  assert.equal(f.service.engine.getTask(1)?.waitStage, 'final');
  assert.ok(f.notifications.some((notice) => notice.text.includes('提醒：预计')));

  await f.service.receive(message('m3', '任务 #1 暂停', 'owner'));
  f.advance(2 * 60 * 60_000);
  await f.service.pump();
  assert.equal(f.service.engine.getTask(1)?.status, 'paused');
  assert.deepEqual(phases, ['investigate']);
});

test('deduplicates bot delivery while linking a second message for the same alert event', async (t) => {
  const f = fixture(t, async (input) => result(input, 'plan'));
  const alert = message('same-message', '[告警:alerts:duplicate] down');
  await f.service.receive(alert);
  await f.service.receive(alert);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.service.engine.listTasks().length, 1);
  assert.equal(f.service.engine.events(1).length, 1);

  await f.service.receive(message('second-message', '[告警:alerts:duplicate] still down'));
  assert.equal(f.service.engine.listTasks().length, 1);
  assert.equal(f.service.engine.events(1).length, 2);
  assert.ok(f.notifications.at(-1)?.text.includes('已关联已有告警任务'));
});

test('runs at most four tasks and starts the fifth after the first four wait for Owners', async (t) => {
  const pending: Array<{ input: PiRunInput; resolve: (value: PiRunResult) => void }> = [];
  let running = 0;
  let maxRunning = 0;
  const f = fixture(t, (input) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    return new Promise<PiRunResult>((resolve) => pending.push({ input, resolve: (value) => { running--; resolve(value); } }));
  }, 4);
  for (let index = 1; index <= 5; index++) {
    await f.service.receive(message(`m${index}`, `[告警:alerts:parallel-${index}] down`));
  }
  await f.service.pump();
  await eventually(() => pending.length === 4, 'four concurrent investigations');
  assert.equal(maxRunning, 4);
  for (const item of pending.slice(0, 4)) item.resolve(result(item.input, 'plan'));
  await eventually(() => f.service.engine.listTasks().filter((task) => task.status === 'plan_notify_pending').length === 4, 'four plans');

  await f.service.pump();
  await eventually(() => pending.length === 5, 'fifth investigation');
  assert.equal(maxRunning, 4);
  pending[4].resolve(result(pending[4].input, 'plan'));
  await eventually(() => f.service.engine.getTask(5)?.status === 'plan_notify_pending', 'fifth plan');
});

test('ignores a runner result returned after shutdown interrupted its fenced run', async (t) => {
  let pending: { input: PiRunInput; resolve: (value: PiRunResult) => void } | undefined;
  const f = fixture(t, (input) => new Promise<PiRunResult>((resolve) => { pending = { input, resolve }; }));
  await f.service.receive(message('m1', '[告警:alerts:interrupted] down'));
  await f.service.pump();
  await eventually(() => !!pending, 'runner start');

  const stopping = f.service.shutdown();
  assert.equal(pending!.input.signal?.aborted, true);
  pending!.resolve(result(pending!.input, 'plan'));
  await stopping;
  assert.equal(f.service.engine.getTask(1)?.planVersion, 0);
  assert.equal(f.service.engine.getTask(1)?.status, 'queued');
});

test('rolls task intake back when the inbox receipt cannot be recorded', async (t) => {
  const f = fixture(t, async (input) => result(input, 'plan'));
  const originalRun = f.store.run.bind(f.store);
  f.store.run = ((sql: string, ...values: Parameters<Store['run']>[1][]) => {
    if (sql.startsWith('INSERT OR IGNORE INTO inbox')) throw new Error('injected inbox failure');
    return originalRun(sql, ...values);
  }) as Store['run'];

  await assert.rejects(
    f.service.receive(message('atomic', '[告警:alerts:atomic] down')),
    /injected inbox failure/,
  );
  assert.equal(f.service.engine.listTasks().length, 0);
  assert.equal(f.store.get<{ count: number }>('SELECT count(*) AS count FROM events')?.count, 0);
  assert.equal(f.store.get<{ count: number }>('SELECT count(*) AS count FROM inbox')?.count, 0);
});

test('remote HEAD and failed Agent review invalidate delivery and schedule retry', async (t) => {
  const phases: string[] = [];
  const expectedHeads: Array<string|undefined> = [];
  const f = fixture(t, async (input) => { phases.push(input.phase); return result(input, input.phase === 'investigate' ? 'plan' : 'fixed'); });
  const prepare=f.service.deps.git.prepare;
  f.service.deps.git.prepare=async (...args)=>{expectedHeads.push(args[3]);return prepare(...args);};
  await f.service.receive(message('m1', '[告警:alerts:head-change] down'));
  await f.service.pump();
  await eventually(() => f.service.engine.getTask(1)?.status === 'plan_notify_pending', 'plan');
  await f.service.pump();
  await f.service.receive(message('m2', '任务 #1 同意', 'owner'));
  await f.service.pump();
  await eventually(() => f.service.engine.getTask(1)?.status === 'awaiting_checks', 'MR');
  f.advance(30_000);
  await f.service.pump();
  assert.equal(f.service.engine.getTask(1)?.status, 'delivered');

  f.setDeliveryStatus({
    mergeRequest: { iid: 7, url: 'https://git.test/mr/7', state: 'opened', sourceBranch: 'fix/faizili_1', targetBranch: 'master', head: 'head-2' },
    currentHead: false, agentReviewPassed: false, agentReviewStatus: 'pending', mergeable: true,
    checks: { build: 'pending' }, ownerRequired: true, complete: false,
  });
  f.advance(30_000);
  await f.service.pump();
  assert.equal(f.service.engine.getTask(1)?.headSha, 'head-2');
  assert.equal(f.service.engine.getTask(1)?.status, 'awaiting_checks');
  assert.equal(f.service.engine.getTask(1)?.completedAt, null);
  assert.ok(f.notifications.some((notice) => notice.text.includes('存在冲突')));

  f.setDeliveryStatus({
    mergeRequest: { iid: 7, url: 'https://git.test/mr/7', state: 'opened', sourceBranch: 'fix/faizili_1', targetBranch: 'master', head: 'head-2' },
    currentHead: true, agentReviewPassed: false, agentReviewStatus: 'failed', mergeable: true,
    checks: { build: 'success' }, ownerRequired: false, complete: false,
  });
  f.advance(30_000);
  await f.service.pump();
  assert.equal(f.service.engine.getTask(1)?.status, 'queued');
  await f.service.pump();
  await eventually(() => phases.length === 3, 'Agent review retry run');
  await eventually(() => f.service.active.size === 0, 'Agent review retry completion');
  assert.equal(phases[2], 'execute');
  assert.deepEqual(expectedHeads,[undefined,undefined,'head-2']);
});

test('requests missing Agent review idempotently for each current MR head',async t=>{
  const f=fixture(t,async input=>result(input,input.phase==='investigate'?'plan':'fixed'));
  await f.service.receive(message('review-request-1','[告警:alerts:review-request] down'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='plan_notify_pending','plan');
  await f.service.pump();await f.service.receive(message('review-request-2','任务 #1 同意','owner'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='awaiting_checks','MR');
  f.setDeliveryStatus({
    mergeRequest:{iid:7,url:'https://git.test/mr/7',state:'opened',sourceBranch:'fix/faizili_1',targetBranch:'master',head:'head-1'},
    currentHead:true,agentReviewPassed:false,agentReviewStatus:'pending',mergeable:true,checks:{build:'pending'},ownerRequired:false,complete:false,
  });
  f.advance(30_000);await f.service.pump();
  f.advance(30_000);await f.service.pump();
  f.setDeliveryStatus({
    mergeRequest:{iid:7,url:'https://git.test/mr/7',state:'opened',sourceBranch:'fix/faizili_1',targetBranch:'master',head:'head-2'},
    currentHead:false,agentReviewPassed:false,agentReviewStatus:'pending',mergeable:true,checks:{build:'pending'},ownerRequired:false,complete:false,
  });
  f.advance(30_000);await f.service.pump();
  assert.deepEqual(f.calls.ensureAgentReview,[{mrIid:7,head:'head-1'},{mrIid:7,head:'head-1'},{mrIid:7,head:'head-2'}]);
});

test('does not request Agent review after a status wait pauses the task or for a closed MR',async t=>{
  const f=fixture(t,async input=>result(input,input.phase==='investigate'?'plan':'fixed'));
  await f.service.receive(message('review-race-1','[告警:alerts:review-race] down'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='plan_notify_pending','plan');
  await f.service.pump();await f.service.receive(message('review-race-2','任务 #1 同意','owner'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='awaiting_checks','MR');
  let release!:()=>void;let started!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  const observed=new Promise<void>(resolve=>{started=resolve;});
  f.service.deps.delivery.status=async()=>{
    started();await waiting;
    return {mergeRequest:{iid:7,url:'https://git.test/mr/7',state:'opened',sourceBranch:'fix/faizili_1',targetBranch:'master',head:'head-1'},currentHead:true,agentReviewPassed:false,agentReviewStatus:'pending',mergeable:true,checks:{build:'pending'},ownerRequired:false,complete:false};
  };
  f.advance(30_000);const poll=f.service.pump();await observed;
  await f.service.receive(message('review-race-3','任务 #1 暂停','owner'));release();await poll;
  assert.equal(f.service.engine.getTask(1)?.status,'paused');
  assert.deepEqual(f.calls.ensureAgentReview,[]);

  await f.service.receive(message('review-race-4','任务 #1 恢复','owner'));
  f.service.deps.delivery.status=async()=>({mergeRequest:{iid:7,url:'https://git.test/mr/7',state:'closed',sourceBranch:'fix/faizili_1',targetBranch:'master',head:'head-1'},currentHead:true,agentReviewPassed:false,agentReviewStatus:'pending',mergeable:false,checks:{build:'pending'},ownerRequired:false,complete:false});
  f.advance(30_000);await f.service.pump();
  assert.deepEqual(f.calls.ensureAgentReview,[]);
});

test('preserves actionable review feedback and supplies it to the next runner', async (t) => {
  const inputs: PiRunInput[] = [];
  const f = fixture(t, async (input) => { inputs.push(input); return result(input, input.phase === 'investigate' ? 'plan' : 'fixed'); });
  await f.service.receive(message('m1', '[告警:alerts:review] down'));
  await f.service.pump();
  await eventually(() => f.service.engine.getTask(1)?.status === 'plan_notify_pending', 'plan');
  await f.service.pump();
  await f.service.receive(message('m2', '任务 #1 同意', 'owner'));
  await f.service.pump();
  await eventually(() => f.service.engine.getTask(1)?.status === 'awaiting_checks', 'MR');

  f.setDeliveryStatus({
    mergeRequest: { iid: 7, url: 'https://git.test/mr/7', state: 'opened', sourceBranch: 'fix/faizili_1', targetBranch: 'master', head: 'head-1' },
    currentHead: true, agentReviewPassed: false, agentReviewStatus: 'pending', mergeable: true,
    checks: { build: 'pending' }, ownerRequired: false, complete: false,
  });
  f.setFeedback([{ id: 11, body: 'Handle the nil lease before retrying.', classification: 'change-request' }]);
  f.advance(30_000);
  await f.service.pump();
  assert.equal(f.service.engine.getTask(1)?.status, 'queued');
  assert.equal(f.service.engine.events(1).at(-1)?.text, 'Handle the nil lease before retrying.');

  await f.service.pump();
  await eventually(() => inputs.length === 3, 'feedback retry run');
  await eventually(() => f.service.active.size === 0, 'feedback retry completion');
  assert.match(inputs[2].prompt, /Handle the nil lease before retrying\./);
});

test('drops a pending no-code notification retry after explicit closure', async (t) => {
  const f = fixture(t, async (input) => result(input, 'no-code'));
  await f.service.receive(message('m1', '[告警:alerts:no-code-retry] recovered'));
  await f.service.pump();
  await eventually(() => f.service.engine.getTask(1)?.status === 'no_code_wait', 'no-code result');
  const effect = f.service.engine.outbox().find((item) => item.type === 'notify_no_code')!;
  f.store.run('INSERT INTO effect_retry(effect_id,next_at,attempts) VALUES(?,?,?)', effect.id, 1_001_000, 1);

  await f.service.receive(message('m2', '任务 #1 确认关闭', 'owner'));
  const notices = f.notifications.length;
  f.advance(1_000);
  await f.service.pump();
  assert.equal(f.notifications.length, notices);
  assert.equal(f.service.engine.outbox().some((item) => item.id === effect.id), false);
});

test('blocks when MR recovery finds only a closed MR', async (t) => {
  const phases: string[] = [];
  const f = fixture(t, async (input) => { phases.push(input.phase); return result(input, input.phase === 'investigate' ? 'plan' : 'fixed'); });
  f.setDeliveryStatus({
    mergeRequest: { iid: 7, url: 'https://git.test/mr/7', state: 'closed', sourceBranch: 'fix/faizili_1', targetBranch: 'master', head: 'head-1' },
    currentHead: true, agentReviewPassed: false, agentReviewStatus: 'pending', mergeable: false,
    checks: { build: 'pending' }, ownerRequired: false, complete: false,
  });
  await f.service.receive(message('m1', '[告警:alerts:closed-mr] down'));
  await f.service.pump();
  await eventually(() => f.service.engine.getTask(1)?.status === 'plan_notify_pending', 'plan');
  await f.service.pump();
  await f.service.receive(message('m2', '任务 #1 同意', 'owner'));
  await f.service.pump();
  await eventually(() => f.service.engine.getTask(1)?.status === 'blocked', 'closed MR block');
  await f.service.pump();
  assert.match(f.service.engine.getTask(1)!.blockReason!, /closed/);
  assert.ok(f.notifications.some((notice) => notice.text.includes('需要 Owner 介入')));
  assert.deepEqual(phases, ['investigate', 'execute']);
});

for (const state of ['closed', 'merged'] as const) {
  test(`cleans a completed workspace after its MR is ${state} and clears the runtime pointer`, async (t) => {
    const f = fixture(t, async (input) => result(input, input.phase === 'investigate' ? 'plan' : 'fixed'));
    await f.service.receive(message('m1', `[告警:alerts:cleanup-${state}] down`));
    await f.service.pump();
    await eventually(() => f.service.engine.getTask(1)?.status === 'plan_notify_pending', 'plan');
    await f.service.pump();
    await f.service.receive(message('m2', '任务 #1 同意', 'owner'));
    await f.service.pump();
    await eventually(() => f.service.engine.getTask(1)?.status === 'awaiting_checks', 'MR');
    f.advance(30_000);
    await f.service.pump();
    assert.equal(f.service.engine.getTask(1)?.status, 'delivered');

    const cleanupCalls = f.calls.cleanup;
    f.service.deps.git.cleanup = async () => { f.calls.cleanup++; return true; };
    f.setDeliveryStatus({
      mergeRequest: { iid: 7, url: 'https://git.test/mr/7', state, sourceBranch: 'fix/faizili_1', targetBranch: 'master', head: 'head-1' },
      currentHead: true, agentReviewPassed: true, agentReviewStatus: 'success', mergeable: false,
      checks: { build: 'success' }, ownerRequired: false, complete: false,
    });
    f.advance(7 * 24 * 60 * 60_000 + 30_000);
    await f.service.pump();
    assert.equal(f.calls.cleanup, cleanupCalls + 1);
    assert.equal(f.store.get<{ workspace: string | null }>('SELECT workspace FROM runtime WHERE task_id=1')?.workspace, null);
    f.advance(30_000);
    await f.service.pump();
    assert.equal(f.calls.cleanup, cleanupCalls + 1);
  });
}

test('external-action conclusions block closure and Owner information resumes the same task', async t=>{
  let supplied='';let runs=0;
  const f=fixture(t,async input=>{
    supplied=input.prompt;runs++;
    const value=result(input,'no-code');
    if(value.status==='completed'&&runs===1)value.completion.externalAction='Owner must restore the upstream route';
    return value;
  });
  await f.service.receive(message('external1','[告警:alerts:external] down'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='blocked','external block');
  await f.service.pump();
  assert.ok(f.notifications.some(n=>n.text.includes('restore the upstream route')&&n.owners.includes('owner')));
  await f.service.receive(message('external2','任务 #1 确认关闭','owner'));
  assert.equal(f.service.engine.getTask(1)?.status,'blocked');
  await f.service.receive(message('external3','任务 #1 补充 route restored','intruder'));
  assert.equal(f.service.engine.getTask(1)?.status,'blocked');
  await f.service.receive(message('external4','任务 #1 补充 route restored','owner'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='no_code_wait','new evidence');
  assert.match(supplied,/route restored/);assert.equal(f.service.engine.listTasks().length,1);
});

test('MR observation failure visibly blocks and retry resumes checks without another repair',async t=>{
  let runs=0;
  const f=fixture(t,async input=>{runs++;return result(input,input.phase==='investigate'?'plan':'fixed');});
  await f.service.receive(message('permission1','[告警:alerts:permission] down'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='plan_notify_pending','plan');
  await f.service.pump();await f.service.receive(message('permission2','任务 #1 同意','owner'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='awaiting_checks','MR');
  const status=f.service.deps.delivery.status;
  f.service.deps.delivery.status=async()=>{throw new Error('MR platform access denied');};
  f.advance(30_000);
  const log=console.error;console.error=()=>{};
  try{await f.service.pump();}finally{console.error=log;}
  assert.equal(f.service.engine.getTask(1)?.status,'blocked');
  await f.service.pump();assert.ok(f.notifications.some(n=>n.text.includes('access denied')));
  f.service.deps.delivery.status=status;
  await f.service.receive(message('permission3','任务 #1 重试','owner'));
  assert.equal(f.service.engine.getTask(1)?.status,'awaiting_checks');
  f.advance(30_000);await f.service.pump();assert.equal(f.service.engine.getTask(1)?.status,'delivered');
  assert.equal(runs,2);
});

test('rewritten model evidence alone cannot evade the three-round no-progress block',async t=>{
  let rounds=0;
  const f=fixture(t,async input=>{
    const value=result(input,input.phase==='investigate'?'plan':'fixed');
    if(value.status==='completed')value.completion.evidence=[`model claims improvement ${++rounds}`];
    return value;
  });
  const status=f.service.deps.delivery.status;
  f.service.deps.delivery.status=async(...args)=>({...await status(...args),agentReviewPassed:false,agentReviewStatus:'failed',complete:false});
  await f.service.receive(message('progress1','[告警:alerts:progress] down'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='plan_notify_pending','plan');
  await f.service.pump();await f.service.receive(message('progress2','任务 #1 同意','owner'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='awaiting_checks','MR');
  for(let attempt=0;attempt<3;attempt++){
    f.advance(30_000);await f.service.pump();await f.service.pump();
    await eventually(()=>['awaiting_checks','blocked'].includes(f.service.engine.getTask(1)!.status),'repair retry');
  }
  assert.equal(f.service.engine.getTask(1)?.status,'blocked');
  assert.equal(f.service.engine.getTask(1)?.noProgress,3);
});

test('shutdown cancels and drains delivery polling before the caller can close the store',async t=>{
  const f=fixture(t,async input=>result(input,input.phase==='investigate'?'plan':'fixed'));
  await f.service.receive(message('stop-poll-1','[告警:alerts:stop-poll] down'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='plan_notify_pending','plan');
  await f.service.pump();await f.service.receive(message('stop-poll-2','任务 #1 同意','owner'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='awaiting_checks','MR');
  let started!:()=>void;let release!:()=>void;let aborted=false;
  const observed=new Promise<void>(resolve=>{started=resolve;});
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  f.service.deps.delivery.status=async(_iid,_head,signal)=>{
    signal?.addEventListener('abort',()=>{aborted=true;},{once:true});started();await waiting;
    return {mergeRequest:{iid:7,url:'https://git.test/mr/7',state:'opened',sourceBranch:'fix/faizili_1',targetBranch:'master',head:'head-1'},currentHead:true,agentReviewPassed:false,agentReviewStatus:'pending',mergeable:true,checks:{build:'pending'},ownerRequired:false,complete:false};
  };
  f.advance(30_000);const poll=f.service.pump();await observed;
  let stopped=false;const shutdown=f.service.shutdown().then(()=>{stopped=true;});
  await Promise.resolve();assert.equal(aborted,true);assert.equal(stopped,false);
  release();await Promise.all([shutdown,poll]);
  assert.equal(stopped,true);assert.equal(f.service.engine.getTask(1)?.status,'awaiting_checks');
  assert.deepEqual(f.calls.ensureAgentReview,[]);
});

 test('workspace synchronization conflict blocks before Pi and notifies Owner',async t=>{
  let runs=0;
  const f=fixture(t,async input=>{runs++;return result(input,'plan');});
  f.service.deps.git.prepare=async()=>{throw new GitWorkspaceConflictError('Local changes retained; Owner must reconcile the MR branch');};
  await f.service.receive(message('sync-conflict','[告警:alerts:sync-conflict] down'));
  await f.service.pump();
  await eventually(()=>f.service.engine.getTask(1)?.status==='blocked','workspace conflict');
  await f.service.pump();
  assert.equal(runs,0);assert.equal(f.calls.push,0);assert.equal(f.calls.createMr,0);
  assert.ok(f.notifications.some(n=>n.owners.includes('owner')&&n.text.includes('Local changes retained')));
 });

test('alternating known tool results and metadata changes do not reset progress after restart',async t=>{
  let rounds=0;
  const f=fixture(t,async input=>{
    input.onEvent?.({type:'tool_execution_end',toolName:'bash',isError:false,result:{content:[{type:'text',text:++rounds===4?'new evidence C':rounds%2?'known A':'known B'}],details:{durationMs:rounds,fullOutputPath:`/tmp/output-${rounds}`}}});
    return result(input,input.phase==='investigate'?'plan':'fixed');
  });
  const status=f.service.deps.delivery.status;
  f.service.deps.delivery.status=async(...args)=>({...await status(...args),agentReviewPassed:false,agentReviewStatus:'failed',complete:false});
  await f.service.receive(message('novelty1','[告警:alerts:novelty] down'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='plan_notify_pending','plan');
  await f.service.pump();await f.service.receive(message('novelty2','任务 #1 同意','owner'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='awaiting_checks','MR');
  for(let attempt=0;attempt<5;attempt++){
    if(attempt===2){await f.service.shutdown();f.service=new AlertService(f.service.config,f.service.deps,f.store);}
    f.advance(30_000);await f.service.pump();await f.service.pump();
    await eventually(()=>['awaiting_checks','blocked'].includes(f.service.engine.getTask(1)!.status),'repeat result');
    assert.equal(f.service.engine.getTask(1)?.noProgress,[1,0,1,2,3][attempt]);
  }
  assert.equal(f.service.engine.getTask(1)?.status,'blocked');
  assert.equal(f.service.engine.getTask(1)?.noProgress,3);
});

for(const boundary of ['runner','push','mr','uncertain-mr'] as const)test(`pause reports retained progress across ${boundary}`,async t=>{
  const f=fixture(t,async input=>{if(boundary==='runner'&&input.phase==='execute'){entered=true;input.signal?.addEventListener('abort',()=>{aborted=true;});await waiting;}return result(input,input.phase==='investigate'?'plan':'fixed');});
  let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});let entered=false;let aborted=false;
  const push=f.service.deps.git.push;const create=f.service.deps.delivery.createOrReadMergeRequest;
  if(boundary==='push')f.service.deps.git.push=async(...args)=>{entered=true;args[1]?.addEventListener('abort',()=>{aborted=true;});await waiting;return push(...args);};
  else if(boundary!=='runner')f.service.deps.delivery.createOrReadMergeRequest=async(...args)=>{entered=true;args[1]?.addEventListener('abort',()=>{aborted=true;});await waiting;if(boundary==='uncertain-mr')throw new Error('receipt unavailable');return create(...args);};
  f.service.deps.git.status=async()=> ' M worker.ts\n?? notes.txt';
  const notify=f.service.deps.notify;let failReport=boundary==='mr';
  f.service.deps.notify=async(...args)=>{if(failReport&&args[1].includes('本轮执行已停止')){failReport=false;throw new Error('temporary notification failure');}await notify(...args);};
  await f.service.receive(message('pause-race1','[告警:alerts:pause-race] down'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='plan_notify_pending','plan');
  await f.service.pump();await f.service.receive(message('pause-race2','任务 #1 同意','owner'));
  await f.service.pump();await eventually(()=>entered,'external write boundary');
  await f.service.receive(message('pause-race3','任务 #1 暂停','owner'));
  const stopping=f.service.pump();await eventually(()=>aborted,'write cancellation');release();await stopping;
  if(boundary==='mr'){
    await f.service.shutdown();f.service=new AlertService(f.service.config,f.service.deps,f.store);
    f.service.deps.git.status=async()=>{throw new Error('must replay saved report');};
    f.advance(3_000);await f.service.pump();
  }
  assert.equal(f.service.engine.getTask(1)?.status,'paused');
  const report=f.notifications.find(n=>n.text.includes('本轮执行已停止'));
  assert.ok(report,'must send factual stop progress');
  assert.match(report.text,/2 项未提交改动，已保留/);
  assert.match(report.text,/head-1/);if(boundary==='runner')assert.match(report.text,/本轮未发起推送/);else assert.match(report.text,/已确认推送/);
  if(boundary==='push'||boundary==='runner'){assert.equal(f.calls.createMr,0);assert.match(report.text,/未发起 MR/);}
  if(boundary==='mr'){assert.match(report.text,/https:\/\/git.test\/mr\/7/);assert.equal(f.service.engine.getTask(1)?.mrUrl,'https://git.test/mr/7');}
  if(boundary==='uncertain-mr')assert.match(report.text,/MR.*待核实/);
  const paused=f.service.engine.getTask(1)!;
  assert.equal(f.service.engine.recordMr(1,{url:'https://git.test/mr/wrong',branch:'fix/faizili_1',headSha:'wrong',run:{runId:'wrong-run',fence:paused.runFence-1,planVersion:paused.planVersion}}).accepted,false);
  assert.deepEqual(f.calls.ensureAgentReview,[]);
});

test('a confirmed late push updates an existing MR head without resuming the paused task',async t=>{
  const f=fixture(t,async input=>result(input,input.phase==='investigate'?'plan':'fixed'));
  await f.service.receive(message('existing-pause1','[告警:alerts:existing-pause] down'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='plan_notify_pending','plan');
  await f.service.pump();await f.service.receive(message('existing-pause2','任务 #1 同意','owner'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='awaiting_checks','first MR');
  const status=f.service.deps.delivery.status;
  f.service.deps.delivery.status=async(...args)=>({...await status(...args),agentReviewPassed:false,agentReviewStatus:'failed',complete:false});
  f.service.deps.git.head=async()=> 'head-2';
  let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});let entered=false;
  f.service.deps.git.push=async()=>{entered=true;await waiting;return {head:'head-2',alreadyPresent:false};};
  f.advance(30_000);await f.service.pump();await f.service.pump();await eventually(()=>entered,'second push');
  await f.service.receive(message('existing-pause3','任务 #1 暂停','owner'));
  const stopping=f.service.pump();release();await stopping;
  const paused=f.service.engine.getTask(1)!;
  assert.equal(paused.status,'paused');assert.equal(paused.headSha,'head-2');assert.equal(paused.mrUrl,'https://git.test/mr/7');
  assert.equal(f.calls.createMr,1);assert.deepEqual(f.calls.ensureAgentReview,[]);
  assert.ok(f.notifications.some(n=>n.text.includes('已确认推送：head-2')&&n.text.includes('保留已有 MR')));
});


test('blocked task proactively mentions Owner with retry instructions and retries a failed notification',async t=>{
  const f=fixture(t,async()=>{throw new Error('Pi emitted invalid JSON');});
  f.service.config.bot.mention='@Test Agent';
  const notify=f.service.deps.notify;let rejected=false;
  f.service.deps.notify=async(group,text,owners)=>{
    if(text.includes('需要 Owner 介入')&&!rejected){rejected=true;throw new Error('notification unavailable');}
    await notify(group,text,owners);
  };
  await f.service.receive(message('blocked-owner','[告警:alerts:blocked-owner] down'));
  for(let attempt=0;attempt<3;attempt++){
    await f.service.pump();
    await eventually(()=>f.service.active.size===0,'failed executor stopped');
  }
  assert.equal(f.service.engine.getTask(1)?.status,'blocked');
  await f.service.pump();
  assert.equal(rejected,true);
  assert.ok(f.service.engine.outbox().some(e=>e.type==='notify_blocked'));
  f.advance(3_000);await f.service.pump();
  const notice=f.notifications.find(n=>n.text.includes('需要 Owner 介入'));
  assert.ok(notice);assert.equal(notice.groupId,'group');assert.deepEqual(notice.owners,['owner']);
  assert.match(notice.text,/Pi emitted invalid JSON/);assert.match(notice.text,/连续无进展轮次：3/);
  assert.match(notice.text,/@Test Agent 发送“任务 #1 重试”/);assert.match(notice.text,/任务 #1 补充 具体信息/);
  assert.equal(f.service.engine.outbox().some(e=>e.type==='notify_blocked'),false);
  await f.service.pump();
  assert.equal(f.notifications.filter(n=>n.text.includes('需要 Owner 介入')).length,1);
});


test('configured report URL keeps plan notifications short and pins the notified version',async t=>{
  const f=fixture(t,async input=>{
    assert.match(input.prompt,/任务 #1/);
    const value=result(input,'plan');
    if(value.status==='plan'){value.summary='初步发现下游超时，根因尚待验证。';value.plan.diagnosis='已发现待验证的下游超时。'.repeat(100);value.plan.evidence=['私有详细证据不应塞入群消息'];}
    return value;
  });
  f.service.config.dashboardUrl='https://alerts.test/';
  await f.service.receive(message('report-plan','[告警:alerts:report-plan] down'));
  await f.service.pump();await eventually(()=>f.service.engine.getTask(1)?.status==='plan_notify_pending','plan');await f.service.pump();
  const notice=f.notifications.find(n=>n.text.includes('[告警方案:1:1]'))!;
  assert.ok(notice.text.includes('https://alerts.test/tasks/1?version=1'));
  assert.ok(notice.text.includes('初步发现下游超时，根因尚待验证。'));
  assert.ok(!notice.text.includes('私有详细证据不应塞入群消息'));
  assert.ok(Buffer.byteLength(notice.text)<1800);assert.deepEqual(notice.owners,['owner']);
  assert.equal(f.service.engine.getTask(1)?.status,'awaiting_owner');
});
