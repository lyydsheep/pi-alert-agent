import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Engine, type Effect, type Plan } from '../src/engine.ts';
import { Store } from '../src/store.ts';

const plan: Plan = {
  body: 'Fix the timeout at the shared request boundary',
  diagnosis: 'requests outlive their lease',
  evidence: ['trace-1'],
  scope: 'request worker',
  solution: 'honor the lease',
  acceptance: 'the reproduction passes',
  risks: 'in-flight requests stop earlier',
};

function fixture(options: { concurrency?: number; runTimeoutMs?: number } = {}) {
  let now = 1_000_000;
  const store = new Store();
  const engine = new Engine(store, {
    ownersByGroup: { origin: ['owner-a', 'owner-b'], other: ['intruder'] },
    waitMs: 30 * 60_000,
    concurrency: options.concurrency,
    runTimeoutMs: options.runTimeoutMs,
    now: () => now,
  });
  return { engine, store, advance: (ms: number) => { now += ms; } };
}

function startInvestigation(engine: Engine, eventId: string) {
  const intake = engine.intake({ source: 'alertmanager', eventId, groupId: 'origin', senderId: 'bot', text: `alert ${eventId}` });
  const effect = engine.tick().find((candidate) => candidate.type === 'start_run' && candidate.taskId === intake.task.id)!;
  return { taskId: intake.task.id, effect, run: effect.payload as { runId: string; fence: number; planVersion: number } };
}

function reachPlan(engine: Engine, eventId: string) {
  const started = startInvestigation(engine, eventId);
  const result = engine.completeRun({ ...started.run, taskId: started.taskId, progress: true, next: 'plan', plan });
  assert.equal(result.accepted, true);
  return { taskId: started.taskId, version: result.task.planVersion, notify: result.effects[0] };
}

test('deduplicates only source event identity and preserves the origin authority', () => {
  const { engine } = fixture();
  const first = engine.intake({ source: 'alerts', eventId: 'evt-1', groupId: 'origin', senderId: 'bot', text: 'cpu high' });
  const duplicate = engine.intake({ source: 'alerts', eventId: 'evt-1', groupId: 'other', senderId: 'bot', text: 'same event in another group' });
  const similar = engine.intake({ source: 'alerts', eventId: 'evt-2', groupId: 'origin', senderId: 'bot', text: 'cpu high' });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.task.id, first.task.id);
  assert.equal(duplicate.task.groupId, 'origin');
  assert.deepEqual(duplicate.task.ownerIds, ['owner-a', 'owner-b']);
  assert.equal(engine.events(first.task.id).length, 2);
  assert.notEqual(similar.task.id, first.task.id);
});

test('starts each 30 minute wait only after the corresponding successful receipt', () => {
  const { engine, advance } = fixture();
  const proposed = reachPlan(engine, 'timer');

  engine.ackEffect(proposed.notify.id);
  assert.equal(engine.recordNotification(proposed.taskId, proposed.version, 'plan', false).task.waitUntil, null);
  const retriedPlan = engine.tick().find((effect) => effect.type === 'notify_plan')!;
  engine.ackEffect(retriedPlan.id);
  engine.recordNotification(proposed.taskId, proposed.version, 'plan', true, 'plan-message');
  assert.equal(engine.findTaskByMessageId('plan-message')?.planVersion, proposed.version);
  const firstDeadline = engine.getTask(proposed.taskId)!.waitUntil!;

  advance(30 * 60_000 - 1);
  assert.equal(engine.tick().some((effect) => effect.type === 'send_reminder'), false);
  advance(1);
  const reminder = engine.tick().find((effect) => effect.type === 'send_reminder')!;
  assert.equal(engine.getTask(proposed.taskId)!.status, 'reminder_pending');
  assert.equal(firstDeadline, 1_000_000 + 30 * 60_000);

  engine.ackEffect(reminder.id);
  engine.recordNotification(proposed.taskId, proposed.version, 'reminder', false);
  assert.equal(engine.getTask(proposed.taskId)!.waitUntil, null);
  const retriedReminder = engine.tick().find((effect) => effect.type === 'send_reminder')!;
  engine.ackEffect(retriedReminder.id);
  engine.recordNotification(proposed.taskId, proposed.version, 'reminder', true);

  advance(30 * 60_000);
  const start = engine.tick().find((effect) => effect.type === 'start_run')!;
  assert.equal(start.payload.phase, 'fix');
  assert.equal(engine.getTask(proposed.taskId)!.status, 'running');
});

test('enforces verified owner, current plan, defer, unknown, rejection and execution pause', () => {
  const { engine, advance } = fixture();
  const proposed = reachPlan(engine, 'commands');
  engine.recordNotification(proposed.taskId, proposed.version, 'plan', true);

  assert.equal(engine.ownerCommand({ taskId: proposed.taskId, planVersion: proposed.version, groupId: 'other', senderId: 'intruder', command: 'approve' }).reason, 'unauthorized');
  assert.equal(engine.ownerCommand({ taskId: proposed.taskId, planVersion: proposed.version - 1, groupId: 'origin', senderId: 'owner-a', command: 'approve' }).reason, 'stale_plan');

  advance(10);
  const deferred = engine.ownerCommand({ taskId: proposed.taskId, planVersion: proposed.version, groupId: 'origin', senderId: 'owner-a', command: 'defer' });
  assert.equal(deferred.task.waitStage, 'initial');
  assert.equal(deferred.task.waitUntil, 1_000_010 + 30 * 60_000);
  assert.equal(engine.ownerCommand({ taskId: proposed.taskId, planVersion: proposed.version, groupId: 'origin', senderId: 'owner-a', command: 'unknown' }).task.status, 'needs_confirmation');
  assert.equal(engine.ownerCommand({ taskId: proposed.taskId, planVersion: proposed.version, groupId: 'origin', senderId: 'owner-b', command: 'approve' }).task.status, 'ready');

  const running = engine.tick().find((effect) => effect.type === 'start_run')!;
  assert.equal(engine.ownerCommand({ taskId: proposed.taskId, planVersion: proposed.version, groupId: 'origin', senderId: 'owner-b', command: 'defer' }).reason, 'only_pause_or_reject_during_run');
  const paused = engine.ownerCommand({ taskId: proposed.taskId, planVersion: proposed.version, groupId: 'origin', senderId: 'owner-b', command: 'pause' });
  assert.equal(paused.task.status, 'paused');
  assert.equal(paused.effects[0].type, 'stop_run');
  assert.equal(engine.completeRun({ taskId: proposed.taskId, runId: String(running.payload.runId), fence: Number(running.payload.fence), planVersion: proposed.version, progress: true, next: 'ready' }).accepted, false);
  assert.equal(engine.submitPlan(proposed.taskId, plan, { runId: String(running.payload.runId), fence: Number(running.payload.fence), planVersion: proposed.version }).accepted, false);
  assert.equal(engine.ownerCommand({ taskId: proposed.taskId, planVersion: proposed.version, groupId: 'origin', senderId: 'owner-a', command: 'resume' }).task.status, 'ready');

  engine.ownerCommand({ taskId: proposed.taskId, planVersion: proposed.version, groupId: 'origin', senderId: 'owner-a', command: 'reject' });
  assert.equal(engine.ownerCommand({ taskId: proposed.taskId, planVersion: proposed.version, groupId: 'origin', senderId: 'owner-b', command: 'approve' }).reason, 'resume_required');
});

test('allows an Owner to pause and resume the initial investigation', () => {
  const { engine } = fixture();
  const started = startInvestigation(engine, 'initial-pause');
  const paused = engine.ownerCommand({
    taskId: started.taskId, planVersion: 0, groupId: 'origin', senderId: 'owner-a', command: 'pause',
  });
  assert.equal(paused.accepted, true);
  assert.equal(paused.task.status, 'paused');
  assert.equal(paused.effects[0].type, 'stop_run');

  const resumed = engine.ownerCommand({
    taskId: started.taskId, planVersion: 0, groupId: 'origin', senderId: 'owner-a', command: 'resume',
  });
  assert.equal(resumed.accepted, true);
  const restart = engine.tick().find((effect) => effect.type === 'start_run')!;
  assert.equal(restart.payload.phase, 'investigate');
  assert.notEqual(restart.payload.runId, started.run.runId);
});

test('claims atomically up to the limit and fences runs across startup recovery', () => {
  const { engine } = fixture({ concurrency: 4 });
  for (let index = 0; index < 5; index++) {
    engine.intake({ source: 'alerts', eventId: `parallel-${index}`, groupId: 'origin', senderId: 'bot', text: 'alert' });
  }
  const firstClaims = engine.tick().filter((effect) => effect.type === 'start_run');
  assert.equal(firstClaims.length, 4);
  assert.equal(engine.tick().filter((effect) => effect.type === 'start_run').length, 0);

  const old = firstClaims[0];
  assert.equal(engine.recoverRuns(), 4);
  const replacements = engine.tick().filter((effect) => effect.type === 'start_run');
  assert.equal(replacements.length, 4);
  assert.equal(engine.completeRun({
    taskId: old.taskId, runId: String(old.payload.runId), fence: Number(old.payload.fence),
    planVersion: Number(old.payload.planVersion), progress: true, next: 'ready',
  }).accepted, false);
});

test('restores a persisted wait without extending its deadline', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-alert-engine-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'state.sqlite');
  let now = 10_000;
  const options = { ownersByGroup: { origin: ['owner-a'] }, waitMs: 30 * 60_000, now: () => now };
  const firstStore = new Store(path);
  const first = new Engine(firstStore, options);
  const proposed = reachPlan(first, 'restart-wait');
  first.recordNotification(proposed.taskId, proposed.version, 'plan', true);
  const deadline = first.getTask(proposed.taskId)!.waitUntil;
  firstStore.close();

  now += 30 * 60_000;
  const secondStore = new Store(path);
  t.after(() => secondStore.close());
  const second = new Engine(secondStore, options);
  assert.equal(second.getTask(proposed.taskId)!.waitUntil, deadline);
  assert.equal(second.tick().find((effect) => effect.type === 'send_reminder')?.taskId, proposed.taskId);
});

test('expires runs at 60 minutes and blocks after three complete no-progress rounds', () => {
  const { engine, advance } = fixture({ concurrency: 1, runTimeoutMs: 60 * 60_000 });
  const started = startInvestigation(engine, 'stuck');
  let run: Effect = started.effect;
  for (let round = 1; round <= 3; round++) {
    advance(60 * 60_000);
    const effects = engine.tick();
    assert.ok(effects.some((effect) => effect.type === 'stop_run' && effect.payload.runId === run.payload.runId));
    if (round < 3) {
      run = effects.find((effect) => effect.type === 'start_run')!;
      assert.equal(engine.getTask(started.taskId)!.noProgress, round);
    }
  }
  assert.equal(engine.getTask(started.taskId)!.status, 'blocked');
  assert.equal(engine.getTask(started.taskId)!.noProgress, 3);
  const resumed = engine.ownerCommand({ taskId: started.taskId, planVersion: 0, groupId: 'origin', senderId: 'owner-a', command: 'resume' }).task;
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.noProgress, 0);
});

test('requires explicit owner closure for no-code results', () => {
  const { engine } = fixture();
  const started = startInvestigation(engine, 'no-code');
  const reported = engine.reportNoCode({ taskId: started.taskId, ...started.run, conclusion: 'Upstream recovered; no repository change is justified.' });
  assert.equal(reported.task.status, 'no_code_wait');
  assert.equal(reported.effects[0].type, 'notify_no_code');
  engine.tick();
  assert.equal(engine.getTask(started.taskId)!.status, 'no_code_wait');
  assert.equal(engine.confirmNoCode({ taskId: started.taskId, groupId: 'origin', senderId: 'nobody' }).accepted, false);
  assert.equal(engine.confirmNoCode({ taskId: started.taskId, groupId: 'origin', senderId: 'owner-a' }).task.status, 'closed');
  const terminalApprove = engine.ownerCommand({ taskId: started.taskId, planVersion: 0, groupId: 'origin', senderId: 'owner-a', command: 'approve' });
  assert.equal(terminalApprove.accepted, false);
  assert.equal(terminalApprove.reason, 'task_not_accepting_decisions');
});

test('delivers only current HEAD and reopens only actionable feedback on an open MR', () => {
  const { engine } = fixture();
  const started = startInvestigation(engine, 'mr');
  engine.completeRun({ taskId: started.taskId, ...started.run, progress: true, next: 'awaiting_checks' });
  const taskId = started.taskId;
  const associated = engine.recordMr(taskId, { url: 'https://example.test/mr/1', branch: 'fix/task-1', headSha: 'new' });
  assert.equal(associated.accepted, true);
  assert.equal(associated.effects[0].type, 'notify_mr');
  const lateApproval = engine.ownerCommand({ taskId, planVersion: 0, groupId: 'origin', senderId: 'owner-a', command: 'approve' });
  assert.equal(lateApproval.accepted, false);
  assert.equal(lateApproval.task.status, 'awaiting_checks');

  assert.equal(engine.recordMrChecks({ taskId, headSha: 'old', agentReview: 'passed', requiredChecks: ['passed'] }).accepted, false);
  assert.equal(engine.recordMrChecks({ taskId, headSha: 'new', agentReview: 'passed', requiredChecks: ['failed'] }).task.status, 'queued');
  const retry = engine.tick().find((effect) => effect.type === 'start_run')!;
  engine.recordMr(taskId, {
    url: 'https://example.test/mr/1', branch: 'fix/task-1', headSha: 'new',
    run: { runId: String(retry.payload.runId), fence: Number(retry.payload.fence), planVersion: Number(retry.payload.planVersion) },
  });
  const delivered = engine.recordMrChecks({ taskId, headSha: 'new', agentReview: 'passed', requiredChecks: ['passed'] });
  assert.equal(delivered.task.status, 'delivered');
  assert.equal(delivered.effects[0].type, 'notify_delivered');
  assert.equal(engine.ownerCommand({ taskId, planVersion: 0, groupId: 'origin', senderId: 'owner-a', command: 'approve' }).reason, 'task_not_accepting_decisions');
  const repeated = engine.recordMrChecks({ taskId, headSha: 'new', agentReview: 'passed', requiredChecks: ['passed'] });
  assert.equal(repeated.task.completedAt, delivered.task.completedAt);
  assert.equal(repeated.effects.length, 0);
  assert.equal(engine.recordMr(taskId, { url: 'https://example.test/mr/1', branch: 'fix/task-1', headSha: 'new' }).task.status, 'delivered');
  assert.equal(engine.recordMr(taskId, { url: 'https://example.test/mr/1', branch: 'fix/task-1', headSha: 'new-from-push' }).task.status, 'awaiting_checks');
  assert.equal(engine.recordMrChecks({ taskId, headSha: 'new', agentReview: 'passed', requiredChecks: ['passed'] }).accepted, false);
  engine.recordMrChecks({ taskId, headSha: 'new-from-push', agentReview: 'passed', requiredChecks: ['passed'] });

  assert.equal(engine.handleMrFeedback({ taskId, mrUrl: 'https://example.test/mr/1', mrState: 'open', kind: 'comment' }).reopened, false);
  assert.equal(engine.handleMrFeedback({ taskId, mrUrl: 'https://example.test/mr/1', mrState: 'open', kind: 'change_requested' }).reopened, true);
  assert.equal(engine.getTask(taskId)!.status, 'queued');
  const feedbackRun = engine.tick().find((effect) => effect.type === 'start_run')!;
  assert.equal(engine.recordMrChecks({ taskId, headSha: 'new', agentReview: 'passed', requiredChecks: ['failed'] }).accepted, false);
  engine.recordMr(taskId, {
    url: 'https://example.test/mr/1', branch: 'fix/task-1', headSha: 'newer',
    run: { runId: String(feedbackRun.payload.runId), fence: Number(feedbackRun.payload.fence), planVersion: Number(feedbackRun.payload.planVersion) },
  });
  engine.recordMrChecks({ taskId, headSha: 'newer', agentReview: 'passed', requiredChecks: ['passed'] });
  assert.equal(engine.handleMrFeedback({ taskId, mrUrl: 'https://example.test/mr/1', mrState: 'closed', kind: 'change_requested' }).reopened, false);
  assert.equal(engine.handleMrFeedback({ taskId, mrUrl: 'https://example.test/mr/1', mrState: 'open', kind: 'change_requested' }).reopened, false);
});

test('keeps only the current HEAD MR notification in the durable outbox', () => {
  const { engine } = fixture();
  const started = startInvestigation(engine, 'mr-notification-head');
  engine.completeRun({ taskId: started.taskId, ...started.run, progress: true, next: 'awaiting_checks' });
  engine.recordMr(started.taskId, { url: 'https://example.test/mr/2', branch: 'fix/task-2', headSha: 'head-1' });
  engine.recordMr(started.taskId, { url: 'https://example.test/mr/2', branch: 'fix/task-2', headSha: 'head-2' });

  const notifications = engine.outbox().filter((effect) => effect.type === 'notify_mr');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].payload.headSha, 'head-2');
});

test('does not apply an old plan approval after the task reaches MR checks', () => {
  const { engine } = fixture();
  const proposed = reachPlan(engine, 'late-approval');
  engine.recordNotification(proposed.taskId, proposed.version, 'plan', true);
  engine.ownerCommand({ taskId: proposed.taskId, planVersion: proposed.version, groupId: 'origin', senderId: 'owner-a', command: 'approve' });
  const run = engine.tick().find((effect) => effect.type === 'start_run')!;
  engine.recordMr(proposed.taskId, {
    url: 'https://example.test/mr/3', branch: 'fix/task-3', headSha: 'head-1',
    run: { runId: String(run.payload.runId), fence: Number(run.payload.fence), planVersion: proposed.version },
  });

  const late = engine.ownerCommand({
    taskId: proposed.taskId, planVersion: proposed.version, groupId: 'origin', senderId: 'owner-a', command: 'approve',
  });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, 'decision_not_applicable');
  assert.equal(late.task.status, 'awaiting_checks');
});

test('pause and repeated pause preserve queued investigation and MR-check resume phases',()=>{
  const {engine}=fixture();
  const task=engine.intake({source:'alerts',eventId:'queued-pause',groupId:'origin',senderId:'bot',text:'alert'}).task;
  const command={taskId:task.id,planVersion:0,groupId:'origin',senderId:'owner-a'};
  engine.ownerCommand({...command,command:'pause'});
  engine.ownerCommand({...command,command:'pause'});
  assert.equal(engine.ownerCommand({...command,command:'resume'}).task.status,'queued');
  const run=engine.tick().find(effect=>effect.type==='start_run')!;
  engine.recordMr(task.id,{url:'https://example.test/mr/4',branch:'fix/task-4',headSha:'head',run:{runId:String(run.payload.runId),fence:Number(run.payload.fence),planVersion:0}});
  engine.ownerCommand({...command,command:'pause'});
  assert.equal(engine.ownerCommand({...command,command:'resume'}).task.status,'awaiting_checks');
  assert.equal(engine.getTask(task.id)!.waitUntil,null);
});

test('Owner rejection wins after approval has already dispatched a repair',()=>{
  const {engine}=fixture();const proposed=reachPlan(engine,'reject-dispatched');
  const command={taskId:proposed.taskId,planVersion:proposed.version,groupId:'origin',senderId:'owner-a'};
  engine.ownerCommand({...command,command:'approve'});
  const run=engine.tick().find(effect=>effect.type==='start_run')!;
  const rejected=engine.ownerCommand({...command,senderId:'owner-b',command:'reject'});
  assert.equal(rejected.task.status,'rejected');assert.equal(rejected.task.runId,null);
  assert.equal(rejected.effects[0].type,'stop_run');
  assert.equal(engine.completeRun({...command,runId:String(run.payload.runId),fence:Number(run.payload.fence),progress:true,next:'awaiting_checks'}).accepted,false);
  assert.equal(engine.ownerCommand({...command,command:'approve'}).reason,'resume_required');
});
