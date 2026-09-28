import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';

export type TaskStatus =
  | 'queued' | 'running' | 'plan_notify_pending' | 'awaiting_owner'
  | 'reminder_pending' | 'needs_owner' | 'needs_confirmation' | 'paused'
  | 'rejected' | 'ready' | 'awaiting_checks' | 'no_code_wait'
  | 'blocked' | 'delivered' | 'closed';

export interface Plan {
  body: string;
  background?: string;
  diagnosis?: string;
  evidence?: string[];
  scope?: string;
  solution?: string;
  acceptance?: string;
  risks?: string;
}

export interface Task {
  id: number;
  source: string;
  eventId: string;
  groupId: string;
  ownerIds: string[];
  status: TaskStatus;
  planVersion: number;
  waitStage: 'initial' | 'final' | null;
  waitUntil: number | null;
  runId: string | null;
  runFence: number;
  runDeadline: number | null;
  noProgress: number;
  branch: string | null;
  mrUrl: string | null;
  mrState: string | null;
  headSha: string | null;
  conclusion: string | null;
  blockReason: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  plan?: Plan & {
    version: number;
    notifiedAt: number | null;
    reminderSentAt: number | null;
    notificationMessageId: string | null;
    reminderMessageId: string | null;
  };
}

export type EffectType =
  | 'notify_plan' | 'send_reminder' | 'start_run' | 'stop_run'
  | 'notify_blocked' | 'notify_no_code' | 'notify_delivered' | 'notify_mr';

export interface Effect {
  id: number;
  taskId: number;
  type: EffectType;
  createdAt: number;
  payload: Record<string, unknown>;
}

export interface TaskEvent {
  groupId: string;
  senderId: string;
  text: string;
  receivedAt: number;
}

export interface EngineOptions {
  ownersByGroup?: Record<string, string[]>;
  concurrency?: number;
  waitMs?: number;
  runTimeoutMs?: number;
  now?: () => number;
}

type Row = Record<string, unknown>;
type Result = { task: Task; effects: Effect[] };

export class Engine {
  readonly store: Store;
  private readonly ownersByGroup: Record<string, string[]>;
  private readonly concurrency: number;
  private readonly waitMs: number;
  private readonly runTimeoutMs: number;
  private readonly clock: () => number;

  constructor(store: Store, options: EngineOptions = {}) {
    this.store = store;
    this.ownersByGroup = options.ownersByGroup ?? {};
    this.concurrency = options.concurrency ?? 4;
    this.waitMs = options.waitMs ?? 30 * 60_000;
    this.runTimeoutMs = options.runTimeoutMs ?? 60 * 60_000;
    this.clock = options.now ?? Date.now;
  }

  intake(input: { source: string; eventId: string; groupId: string; senderId: string; text: string }): Result & { created: boolean } {
    return this.store.transaction(() => {
      const now = this.clock();
      let row = this.store.get<Row>('SELECT * FROM tasks WHERE source = ? AND event_id = ?', input.source, input.eventId);
      let created = false;
      if (!row) {
        const owners = this.ownersByGroup[input.groupId] ?? [];
        const inserted = this.store.run(
          `INSERT INTO tasks(source,event_id,group_id,owner_ids,status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?)`,
          input.source, input.eventId, input.groupId, JSON.stringify(owners), 'queued', now, now,
        );
        row = this.store.get<Row>('SELECT * FROM tasks WHERE id = ?', inserted.lastInsertRowid)!;
        created = true;
      }
      this.store.run(
        'INSERT INTO events(task_id,group_id,sender_id,text,received_at) VALUES(?,?,?,?,?)',
        row.id as number, input.groupId, input.senderId, input.text, now,
      );
      return { task: this.readTask(row.id as number)!, effects: [], created };
    });
  }

  submitPlan(taskId: number, plan: Plan, run?: { runId: string; fence: number; planVersion: number }): Result & { accepted: boolean } {
    return this.store.transaction(() => {
      const task = this.requireTask(taskId);
      if (task.status === 'running' && (!run || task.runId !== run.runId || task.runFence !== run.fence || task.planVersion !== run.planVersion)) {
        return { task, effects: [], accepted: false };
      }
      if (task.status !== 'running' && run) return { task, effects: [], accepted: false };
      if (['paused', 'rejected', 'no_code_wait', 'awaiting_checks', 'delivered', 'closed'].includes(task.status)) {
        return { task, effects: [], accepted: false };
      }
      const now = this.clock();
      this.cancelPending(taskId, ['start_run', 'notify_plan', 'send_reminder'], now);
      const version = task.planVersion + 1;
      this.store.run(
        'INSERT INTO plans(task_id,version,body,created_at) VALUES(?,?,?,?)',
        taskId, version, JSON.stringify(plan), now,
      );
      this.store.run(
        `UPDATE tasks SET plan_version=?, status=?, wait_stage=NULL, wait_until=NULL,
         run_id=NULL, run_deadline=NULL, no_progress=0, updated_at=? WHERE id=?`,
        version, 'plan_notify_pending', now, taskId,
      );
      const effect = this.enqueue(taskId, 'notify_plan', { planVersion: version, plan }, now);
      return { task: this.readTask(taskId)!, effects: [effect], accepted: true };
    });
  }

  recordNotification(taskId: number, planVersion: number, kind: 'plan' | 'reminder', success: boolean, messageId?: string): Result & { accepted: boolean } {
    return this.store.transaction(() => {
      const task = this.requireTask(taskId);
      const now = this.clock();
      if (task.planVersion !== planVersion) return { task, effects: [], accepted: false };
      this.cancelPending(taskId, [kind === 'plan' ? 'notify_plan' : 'send_reminder'], now);
      if (!success) return { task, effects: [], accepted: true };

      if (kind === 'plan' && (task.status === 'plan_notify_pending' || task.status === 'needs_owner')) {
        this.store.run('UPDATE plans SET notified_at=?,notification_message_id=? WHERE task_id=? AND version=?', now, messageId ?? null, taskId, planVersion);
        const hasOwners = task.ownerIds.length > 0;
        this.store.run(
          `UPDATE tasks SET status=?, wait_stage=?, wait_until=?, updated_at=? WHERE id=?`,
          hasOwners ? 'awaiting_owner' : 'needs_owner', hasOwners ? 'initial' : null,
          hasOwners ? now + this.waitMs : null, now, taskId,
        );
      } else if (kind === 'reminder' && task.status === 'reminder_pending') {
        this.store.run('UPDATE plans SET reminder_sent_at=?,reminder_message_id=? WHERE task_id=? AND version=?', now, messageId ?? null, taskId, planVersion);
        this.store.run(
          `UPDATE tasks SET status='awaiting_owner', wait_stage='final', wait_until=?, updated_at=? WHERE id=?`,
          now + this.waitMs, now, taskId,
        );
      } else {
        return { task, effects: [], accepted: false };
      }
      return { task: this.readTask(taskId)!, effects: [], accepted: true };
    });
  }

  ownerCommand(input: {
    taskId: number;
    planVersion: number;
    groupId: string;
    senderId: string;
    command: 'approve' | 'defer' | 'pause' | 'reject' | 'resume' | 'unknown';
  }): Result & { accepted: boolean; reason?: string } {
    return this.store.transaction(() => {
      const task = this.requireTask(input.taskId);
      if (input.groupId !== task.groupId || !task.ownerIds.includes(input.senderId)) {
        return { task, effects: [], accepted: false, reason: 'unauthorized' };
      }
      if (input.planVersion !== task.planVersion) {
        return { task, effects: [], accepted: false, reason: 'stale_plan' };
      }
      if (['closed','delivered','no_code_wait'].includes(task.status)) {
        return {task,effects:[],accepted:false,reason:'task_not_accepting_decisions'};
      }
      if (task.planVersion === 0 && !['pause','resume'].includes(input.command)) {
        return { task, effects: [], accepted: false, reason: 'no_plan' };
      }
      if (task.status === 'running' && !['pause','reject'].includes(input.command)) {
        return { task, effects: [], accepted: false, reason: 'only_pause_or_reject_during_run' };
      }
      if (task.status === 'awaiting_checks' && input.command !== 'pause') {
        return { task, effects: [], accepted: false, reason: 'decision_not_applicable' };
      }
      if (task.status === 'paused' && input.command === 'pause') return { task, effects: [], accepted: true };
      const now = this.clock();
      this.store.run(
        'INSERT INTO decisions(task_id,plan_version,group_id,sender_id,command,created_at) VALUES(?,?,?,?,?,?)',
        task.id, input.planVersion, input.groupId, input.senderId, input.command, now,
      );

      let status: TaskStatus = task.status;
      let stage = task.waitStage;
      let until = task.waitUntil;
      const effects: Effect[] = [];
      if (input.command === 'pause') {
        const wasRunning = task.status === 'running';
        status = 'paused'; stage = null; until = null;
        this.store.run('UPDATE tasks SET resume_status=? WHERE id=?', wasRunning ? 'ready' : task.status, task.id);
        if (wasRunning) {
          this.cancelPending(task.id, ['start_run'], now);
          effects.push(this.enqueue(task.id, 'stop_run', { runId: task.runId, fence: task.runFence, reason: 'owner_pause' }, now));
        }
      } else if (input.command === 'reject') {
        status = 'rejected'; stage = null; until = null;
        this.store.run(`UPDATE tasks SET resume_status='awaiting_owner' WHERE id=?`, task.id);
        if (task.status === 'running') {
          this.cancelPending(task.id, ['start_run'], now);
          effects.push(this.enqueue(task.id, 'stop_run', {runId:task.runId,fence:task.runFence,reason:'owner_reject'}, now));
        }
      } else if (input.command === 'resume') {
        if (!['paused', 'rejected', 'needs_confirmation', 'blocked'].includes(task.status)) {
          return { task, effects: [], accepted: false, reason: 'not_suspended' };
        }
        const row = this.store.get<{ resume_status: TaskStatus | null }>('SELECT resume_status FROM tasks WHERE id=?', task.id);
        status = task.status === 'blocked' ? (row?.resume_status === 'awaiting_checks' ? 'awaiting_checks' : task.planVersion ? 'ready' : 'queued')
          : task.status === 'paused' && row?.resume_status ? row.resume_status
          : task.ownerIds.length ? 'awaiting_owner' : 'needs_owner';
        if (status === 'reminder_pending') status = 'awaiting_owner';
        stage = status === 'awaiting_owner' ? 'initial' : null;
        until = status === 'awaiting_owner' ? now + this.waitMs : null;
      } else if (['paused', 'rejected'].includes(task.status)) {
        return { task, effects: [], accepted: false, reason: 'resume_required' };
      } else if (input.command === 'approve') {
        if (!['plan_notify_pending', 'awaiting_owner', 'reminder_pending', 'needs_confirmation'].includes(task.status)) {
          return { task, effects: [], accepted: false, reason: 'decision_not_applicable' };
        }
        status = 'ready'; stage = null; until = null;
      } else if (input.command === 'defer') {
        status = 'awaiting_owner'; stage = 'initial'; until = now + this.waitMs;
        this.store.run('UPDATE plans SET reminder_sent_at=NULL WHERE task_id=? AND version=?', task.id, task.planVersion);
      } else {
        status = 'needs_confirmation'; stage = null; until = null;
      }
      this.cancelPending(task.id, ['notify_plan', 'send_reminder'], now);
      this.store.run(
        'UPDATE tasks SET status=?,wait_stage=?,wait_until=?,run_id=?,run_fence=?,run_deadline=?,no_progress=?,block_reason=NULL,updated_at=? WHERE id=?',
        status, stage, until, ['paused','rejected'].includes(status) ? null : task.runId,
        ['paused','rejected'].includes(status) && task.status === 'running' ? task.runFence + 1 : task.runFence,
        ['paused','rejected'].includes(status) ? null : task.runDeadline,
        input.command === 'resume' && task.status === 'blocked' ? 0 : task.noProgress,
        now, task.id,
      );
      return { task: this.readTask(task.id)!, effects, accepted: true };
    });
  }

  tick(): Effect[] {
    return this.store.transaction(() => {
      const now = this.clock();
      const effects: Effect[] = [];

      for (const row of this.store.all<Row>(`SELECT * FROM tasks WHERE status='running' AND run_deadline<=?`, now)) {
        const task = this.mapTask(row);
        this.cancelPending(task.id, ['start_run'], now);
        effects.push(this.enqueue(task.id, 'stop_run', { runId: task.runId, fence: task.runFence, reason: 'deadline' }, now));
        const noProgress = task.noProgress + 1;
        const blocked = noProgress >= 3;
        this.store.run(
          `UPDATE tasks SET status=?,run_id=NULL,run_deadline=NULL,no_progress=?,block_reason=?,updated_at=? WHERE id=?`,
          blocked ? 'blocked' : 'queued', noProgress, blocked ? 'three runs without progress' : null, now, task.id,
        );
        if (blocked) effects.push(this.enqueue(task.id, 'notify_blocked', { reason: 'three runs without progress' }, now));
      }

      for (const row of this.store.all<Row>(`SELECT * FROM tasks WHERE status='plan_notify_pending'`)) {
        if (!this.hasPending(row.id as number, 'notify_plan')) {
          const task = this.mapTask(row);
          effects.push(this.enqueue(task.id, 'notify_plan', { planVersion: task.planVersion, plan: task.plan }, now));
        }
      }

      for (const row of this.store.all<Row>(
        `SELECT * FROM tasks WHERE status='awaiting_owner' AND wait_until<=? ORDER BY wait_until`, now,
      )) {
        const task = this.mapTask(row);
        if (task.waitStage === 'initial') {
          this.store.run(`UPDATE tasks SET status='reminder_pending',wait_until=NULL,updated_at=? WHERE id=?`, now, task.id);
          effects.push(this.enqueue(task.id, 'send_reminder', {
            planVersion: task.planVersion,
            expectedStartAt: now + this.waitMs,
            commands: ['approve', 'defer', 'pause', 'reject'],
          }, now));
        } else if (task.waitStage === 'final') {
          this.store.run(`UPDATE tasks SET status='ready',wait_stage=NULL,wait_until=NULL,updated_at=? WHERE id=?`, now, task.id);
        }
      }

      for (const row of this.store.all<Row>(`SELECT * FROM tasks WHERE status='reminder_pending'`)) {
        if (!this.hasPending(row.id as number, 'send_reminder')) {
          const task = this.mapTask(row);
          effects.push(this.enqueue(task.id, 'send_reminder', {
            planVersion: task.planVersion,
            expectedStartAt: now + this.waitMs,
            commands: ['approve', 'defer', 'pause', 'reject'],
          }, now));
        }
      }

      let slots = this.concurrency - Number(this.store.get<{ n: number }>(`SELECT count(*) AS n FROM tasks WHERE status='running'`)!.n);
      for (const row of this.store.all<Row>(
        `SELECT * FROM tasks WHERE status IN ('queued','ready') ORDER BY created_at,id LIMIT ?`, Math.max(0, slots),
      )) {
        if (slots-- <= 0) break;
        const task = this.mapTask(row);
        const runId = randomUUID();
        const fence = task.runFence + 1;
        const deadline = now + this.runTimeoutMs;
        const changed = this.store.run(
          `UPDATE tasks SET status='running',run_id=?,run_fence=?,run_deadline=?,updated_at=?
           WHERE id=? AND status=? AND run_id IS NULL`,
          runId, fence, deadline, now, task.id, task.status,
        );
        if (changed.changes !== 1) continue;
        effects.push(this.enqueue(task.id, 'start_run', {
          runId, fence, planVersion: task.planVersion,
          phase: task.planVersion ? 'fix' : 'investigate', deadline,
        }, now));
      }
      return effects;
    });
  }

  completeRun(input: {
    taskId: number;
    runId: string;
    fence: number;
    planVersion: number;
    progress: boolean;
    next: 'plan' | 'ready' | 'awaiting_checks' | 'blocked';
    plan?: Plan;
    reason?: string;
  }): Result & { accepted: boolean } {
    return this.store.transaction(() => {
      const task = this.requireTask(input.taskId);
      if (task.status !== 'running' || task.runId !== input.runId || task.runFence !== input.fence || task.planVersion !== input.planVersion) {
        return { task, effects: [], accepted: false };
      }
      const now = this.clock();
      this.cancelPending(task.id, ['start_run'], now);
      const noProgress = input.progress ? 0 : task.noProgress + 1;
      const effects: Effect[] = [];
      let status: TaskStatus = input.next === 'plan' ? 'plan_notify_pending' : input.next;
      let blockReason = input.reason ?? null;
      let planVersion = task.planVersion;
      if (noProgress >= 3) {
        status = 'blocked';
        blockReason = input.reason ?? 'three runs without progress';
      }
      if (input.next === 'plan' && status !== 'blocked') {
        if (!input.plan) throw new Error('plan is required when next is plan');
        planVersion += 1;
        this.store.run('INSERT INTO plans(task_id,version,body,created_at) VALUES(?,?,?,?)', task.id, planVersion, JSON.stringify(input.plan), now);
        status = 'plan_notify_pending';
        effects.push(this.enqueue(task.id, 'notify_plan', { planVersion, plan: input.plan }, now));
      }
      this.store.run(
        `UPDATE tasks SET status=?,plan_version=?,run_id=NULL,run_deadline=NULL,resume_status=NULL,no_progress=?,block_reason=?,updated_at=? WHERE id=?`,
        status, planVersion, noProgress, blockReason, now, task.id,
      );
      if (status === 'blocked') effects.push(this.enqueue(task.id, 'notify_blocked', { reason: blockReason }, now));
      return { task: this.readTask(task.id)!, effects, accepted: true };
    });
  }

  blockObservation(taskId: number, headSha: string | null, reason: string): void {
    this.store.transaction(() => {
      const task = this.requireTask(taskId);
      if (!['awaiting_checks', 'delivered'].includes(task.status) || task.headSha !== headSha) return;
      const now = this.clock();
      this.store.run("UPDATE tasks SET status='blocked',resume_status='awaiting_checks',completed_at=NULL,block_reason=?,updated_at=? WHERE id=?", reason, now, taskId);
      this.enqueue(taskId, 'notify_blocked', { reason, mrUrl: task.mrUrl }, now);
    });
  }

  ownerInformation(input: {taskId:number;groupId:string;senderId:string;text:string}): Result & {accepted:boolean} {
    return this.store.transaction(() => {
      const task = this.requireTask(input.taskId);
      if (task.groupId !== input.groupId || !task.ownerIds.includes(input.senderId) || !input.text.trim() || ['closed','delivered'].includes(task.status)) return {task,effects:[],accepted:false};
      this.store.run('INSERT INTO events(task_id,group_id,sender_id,text,received_at) VALUES(?,?,?,?,?)', task.id,input.groupId,input.senderId,input.text,this.clock());
      if (task.status === 'blocked') return this.ownerCommand({...input,planVersion:task.planVersion,command:'resume'});
      return {task,effects:[],accepted:true};
    });
  }

  reportNoCode(input: { taskId: number; runId: string; fence: number; planVersion: number; conclusion: string; externalAction?:string }): Result & { accepted: boolean } {
    return this.store.transaction(() => {
      const task = this.requireTask(input.taskId);
      if (task.status !== 'running' || task.runId !== input.runId || task.runFence !== input.fence || task.planVersion !== input.planVersion) {
        return { task, effects: [], accepted: false };
      }
      const now = this.clock();
      this.cancelPending(task.id, ['start_run'], now);
      this.store.run(
        `UPDATE tasks SET status=?,conclusion=?,block_reason=?,resume_status=NULL,run_id=NULL,run_deadline=NULL,no_progress=0,updated_at=? WHERE id=?`,
        input.externalAction ? 'blocked' : 'no_code_wait', input.conclusion, input.externalAction ?? null, now, task.id,
      );
      const effect = this.enqueue(task.id, input.externalAction ? 'notify_blocked' : 'notify_no_code', { conclusion: input.conclusion, reason:input.externalAction, ownerIds: task.ownerIds }, now);
      return { task: this.readTask(task.id)!, effects: [effect], accepted: true };
    });
  }

  confirmNoCode(input: { taskId: number; groupId: string; senderId: string }): Result & { accepted: boolean } {
    return this.store.transaction(() => {
      const task = this.requireTask(input.taskId);
      if (task.status !== 'no_code_wait' || task.groupId !== input.groupId || !task.ownerIds.includes(input.senderId)) {
        return { task, effects: [], accepted: false };
      }
      const now = this.clock();
      this.store.run(`UPDATE tasks SET status='closed',completed_at=?,updated_at=? WHERE id=?`, now, now, task.id);
      return { task: this.readTask(task.id)!, effects: [], accepted: true };
    });
  }

  recordMr(taskId: number, input: {
    url: string;
    branch: string;
    headSha: string;
    state?: 'open' | 'closed' | 'merged';
    run?: { runId: string; fence: number; planVersion: number };
  }): Result & { accepted: boolean } {
    return this.store.transaction(() => {
      const now = this.clock();
      const task = this.requireTask(taskId);
      const state = input.state ?? 'open';
      if (state !== 'open') {
        if (task.status !== 'running' || !input.run || input.run.runId !== task.runId
          || input.run.fence !== task.runFence || input.run.planVersion !== task.planVersion) {
          return { task, effects: [], accepted: false };
        }
        const reason = `Existing MR is ${state}`;
        this.cancelPending(task.id, ['start_run', 'notify_mr'], now);
        this.store.run(
          `UPDATE tasks SET mr_url=?,branch=?,head_sha=?,mr_state=?,status='blocked',run_id=NULL,run_deadline=NULL,
           block_reason=?,updated_at=? WHERE id=?`,
          input.url, input.branch, input.headSha, state, reason, now, task.id,
        );
        const effect = this.enqueue(task.id, 'notify_blocked', { reason, mrUrl: input.url }, now);
        return { task: this.readTask(task.id)!, effects: [effect], accepted: true };
      }
      if (task.status === 'delivered' && task.mrUrl === input.url && task.headSha === input.headSha) {
        return { task, effects: [], accepted: true };
      }
      if (task.status === 'running') {
        if (!input.run || input.run.runId !== task.runId || input.run.fence !== task.runFence || input.run.planVersion !== task.planVersion) {
          return { task, effects: [], accepted: false };
        }
      } else if (task.status !== 'awaiting_checks'
        && !(task.status === 'delivered' && task.mrUrl === input.url && task.mrState === 'open')) {
        return { task, effects: [], accepted: false };
      }
      const changed = task.mrUrl !== input.url || task.headSha !== input.headSha;
      this.cancelPending(task.id, ['start_run', ...(changed ? ['notify_mr' as const] : [])], now);
      this.store.run(
        `UPDATE tasks SET mr_url=?,branch=?,head_sha=?,mr_state=?,status='awaiting_checks',run_id=NULL,run_deadline=NULL,
         no_progress=0,completed_at=NULL,updated_at=? WHERE id=?`,
        input.url, input.branch, input.headSha, state, now, taskId,
      );
      const effects = changed ? [this.enqueue(task.id, 'notify_mr', { mrUrl: input.url, headSha: input.headSha }, now)] : [];
      return { task: this.readTask(taskId)!, effects, accepted: true };
    });
  }

  recordMrChecks(input: {
    taskId: number;
    headSha: string;
    agentReview: 'pending' | 'passed' | 'failed';
    requiredChecks: Array<'pending' | 'passed' | 'failed'>;
  }): Result & { accepted: boolean } {
    return this.store.transaction(() => {
      const task = this.requireTask(input.taskId);
      if (task.headSha !== input.headSha || task.mrState !== 'open') return { task, effects: [], accepted: false };
      if (!['awaiting_checks', 'delivered'].includes(task.status)) return { task, effects: [], accepted: false };
      const now = this.clock();
      const failed = input.agentReview === 'failed' || input.requiredChecks.includes('failed');
      const passed = input.agentReview === 'passed' && input.requiredChecks.every((check) => check === 'passed');
      const effects: Effect[] = [];
      if (passed && task.status !== 'delivered') {
        this.store.run(`UPDATE tasks SET status='delivered',completed_at=?,updated_at=? WHERE id=?`, now, now, task.id);
        effects.push(this.enqueue(task.id, 'notify_delivered', { mrUrl: task.mrUrl, headSha: task.headSha }, now));
      } else if (failed) {
        this.store.run(`UPDATE tasks SET status='queued',completed_at=NULL,updated_at=? WHERE id=?`, now, task.id);
      } else if (task.status !== 'delivered') {
        this.store.run(`UPDATE tasks SET status='awaiting_checks',updated_at=? WHERE id=?`, now, task.id);
      }
      return { task: this.readTask(task.id)!, effects, accepted: true };
    });
  }

  handleMrFeedback(input: {
    taskId: number;
    mrUrl: string;
    mrState: 'open' | 'closed' | 'merged';
    kind: 'change_requested' | 'required_check_failed' | 'comment';
    body?: string;
  }): Result & { reopened: boolean } {
    return this.store.transaction(() => {
      const task = this.requireTask(input.taskId);
      const reopen = ['delivered','awaiting_checks'].includes(task.status) && task.mrUrl === input.mrUrl && task.mrState === 'open' && input.mrState === 'open'
        && (input.kind === 'change_requested' || input.kind === 'required_check_failed');
      if(task.mrUrl===input.mrUrl&&input.mrState==='open'&&input.kind==='change_requested'&&input.body) {
        this.store.run('INSERT INTO events(task_id,group_id,sender_id,text,received_at) VALUES(?,?,?,?,?)',task.id,task.groupId,'mr-review',input.body,this.clock());
      }
      if (reopen) {
        const now = this.clock();
        this.store.run(`UPDATE tasks SET status='queued',completed_at=NULL,mr_state='open',updated_at=? WHERE id=?`, now, task.id);
      } else if (task.mrUrl === input.mrUrl && input.mrState !== 'open') {
        this.store.run('UPDATE tasks SET mr_state=?,updated_at=? WHERE id=?', input.mrState, this.clock(), task.id);
      }
      return { task: this.readTask(task.id)!, effects: [], reopened: reopen };
    });
  }

  getTask(taskId: number): Task | undefined {
    return this.readTask(taskId);
  }

  events(taskId: number): TaskEvent[] {
    return this.store.all<Row>('SELECT * FROM events WHERE task_id=? ORDER BY id', taskId).map((row) => ({
      groupId: String(row.group_id), senderId: String(row.sender_id), text: String(row.text), receivedAt: Number(row.received_at),
    }));
  }

  findTaskByMessageId(messageId: string): { task: Task; planVersion: number } | undefined {
    const row = this.store.get<{ task_id: number; version: number }>(
      `SELECT task_id,version FROM plans WHERE notification_message_id=? OR reminder_message_id=? ORDER BY version DESC LIMIT 1`,
      messageId, messageId,
    );
    if (!row) return undefined;
    return { task: this.requireTask(row.task_id), planVersion: row.version };
  }

  recoverRuns(): number {
    return this.store.transaction(() => {
      const now = this.clock();
      const running = this.store.all<Row>(`SELECT * FROM tasks WHERE status='running'`);
      for (const row of running) {
        const task = this.mapTask(row);
        this.cancelPending(task.id, ['start_run'], now);
        this.store.run(
          `UPDATE tasks SET status=?,run_id=NULL,run_fence=run_fence+1,run_deadline=NULL,updated_at=? WHERE id=?`,
          task.planVersion ? 'ready' : 'queued', now, task.id,
        );
      }
      return running.length;
    });
  }

  listTasks(): Task[] {
    return this.store.all<Row>('SELECT * FROM tasks ORDER BY id').map((row) => this.mapTask(row));
  }

  outbox(): Effect[] {
    return this.store.all<Row>('SELECT * FROM outbox WHERE acknowledged_at IS NULL ORDER BY id').map((row) => this.mapEffect(row));
  }

  ackEffect(id: number): void {
    this.store.run('UPDATE outbox SET acknowledged_at=? WHERE id=?', this.clock(), id);
  }

  private requireTask(taskId: number): Task {
    const task = this.readTask(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    return task;
  }

  private readTask(taskId: number): Task | undefined {
    const row = this.store.get<Row>('SELECT * FROM tasks WHERE id=?', taskId);
    return row ? this.mapTask(row) : undefined;
  }

  private mapTask(row: Row): Task {
    const task: Task = {
      id: Number(row.id), source: String(row.source), eventId: String(row.event_id), groupId: String(row.group_id),
      ownerIds: JSON.parse(String(row.owner_ids)), status: row.status as TaskStatus,
      planVersion: Number(row.plan_version), waitStage: row.wait_stage as Task['waitStage'] ?? null,
      waitUntil: row.wait_until == null ? null : Number(row.wait_until), runId: row.run_id == null ? null : String(row.run_id),
      runFence: Number(row.run_fence), runDeadline: row.run_deadline == null ? null : Number(row.run_deadline),
      noProgress: Number(row.no_progress), branch: row.branch == null ? null : String(row.branch),
      mrUrl: row.mr_url == null ? null : String(row.mr_url), mrState: row.mr_state == null ? null : String(row.mr_state),
      headSha: row.head_sha == null ? null : String(row.head_sha), conclusion: row.conclusion == null ? null : String(row.conclusion),
      blockReason: row.block_reason == null ? null : String(row.block_reason), createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at), completedAt: row.completed_at == null ? null : Number(row.completed_at),
    };
    if (task.planVersion) {
      const plan = this.store.get<Row>('SELECT * FROM plans WHERE task_id=? AND version=?', task.id, task.planVersion);
      if (plan) task.plan = {
        ...JSON.parse(String(plan.body)), version: Number(plan.version),
        notifiedAt: plan.notified_at == null ? null : Number(plan.notified_at),
        reminderSentAt: plan.reminder_sent_at == null ? null : Number(plan.reminder_sent_at),
        notificationMessageId: plan.notification_message_id == null ? null : String(plan.notification_message_id),
        reminderMessageId: plan.reminder_message_id == null ? null : String(plan.reminder_message_id),
      };
    }
    return task;
  }

  private enqueue(taskId: number, type: EffectType, payload: Record<string, unknown>, now: number): Effect {
    const result = this.store.run(
      'INSERT INTO outbox(task_id,type,payload,created_at) VALUES(?,?,?,?)', taskId, type, JSON.stringify(payload), now,
    );
    return { id: Number(result.lastInsertRowid), taskId, type, payload, createdAt: now };
  }

  private hasPending(taskId: number, type: EffectType): boolean {
    return !!this.store.get('SELECT 1 FROM outbox WHERE task_id=? AND type=? AND acknowledged_at IS NULL', taskId, type);
  }

  private cancelPending(taskId: number, types: EffectType[], now: number): void {
    for (const type of types) {
      this.store.run('UPDATE outbox SET acknowledged_at=? WHERE task_id=? AND type=? AND acknowledged_at IS NULL', now, taskId, type);
    }
  }

  private mapEffect(row: Row): Effect {
    return {
      id: Number(row.id), taskId: Number(row.task_id), type: row.type as EffectType,
      payload: JSON.parse(String(row.payload)), createdAt: Number(row.created_at),
    };
  }
}
