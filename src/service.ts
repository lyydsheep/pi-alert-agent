import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Engine, type Effect, type Task } from './engine.ts';
import { Store } from './store.ts';
import { commandFrom, eventFrom, targetFrom, type IncomingMessage } from './wecom.ts';
import type { Config } from './config.ts';
import type { PiRunner } from './pi/index.ts';
import { GitWorkspaceConflictError, type GitWorkspaceManager, type GitWorkspace } from './git.ts';
import type { GitLabDeliveryClient } from './delivery.ts';
import { DeliveryHttpError } from './delivery.ts';

export interface ServiceDependencies {
  runner: Pick<PiRunner,'run'>;
  git: Pick<GitWorkspaceManager,'prepare'|'push'|'head'|'cleanup'>;
  delivery: Pick<GitLabDeliveryClient,'createOrReadMergeRequest'|'status'|'feedback'> & {
    ensureAgentReview?: (mrIid:number,expectedHead:string,signal?:AbortSignal)=>Promise<unknown>;
  };
  notify: (groupId:string,text:string,owners:string[])=>Promise<void>;
  trace?: (taskId:string,runId:string,event:unknown)=>void;
  now?:()=>number;
}

export class AlertService {
  readonly engine: Engine;
  readonly store: Store;
  readonly config: Config;
  readonly deps: ServiceDependencies;
  readonly active = new Map<number,{runId:string;controller:AbortController;promise:Promise<void>}>();
  private pumping = false;
  private pumpDone:Promise<void> = Promise.resolve();
  private readonly stopping = new AbortController();
  private stopped = false;
  private pollAt = 0;
  private now:()=>number;

  constructor(config:Config,deps:ServiceDependencies,store?:Store) {
    this.config=config;this.deps=deps;this.now=deps.now??Date.now;
    mkdirSync(config.dataDir,{recursive:true});
    this.store=store??new Store(join(config.dataDir,'tasks.sqlite'));
    this.engine=new Engine(this.store,{ownersByGroup:Object.fromEntries(Object.entries(config.groups).map(([id,g])=>[id,g.owners])),concurrency:config.concurrency,waitMs:config.waitMs,runTimeoutMs:config.runTimeoutMs,now:this.now});
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS inbox (message_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime (task_id INTEGER PRIMARY KEY, workspace TEXT, mr_iid INTEGER, feedback_id INTEGER NOT NULL DEFAULT 0, progress_key TEXT);
      CREATE TABLE IF NOT EXISTS effect_retry (effect_id INTEGER PRIMARY KEY, next_at INTEGER NOT NULL, attempts INTEGER NOT NULL);`);
  }

  async receive(message:IncomingMessage):Promise<void> {
    if(!this.config.groups[message.groupId])return;
    const inboxKey=`${message.groupId}:${message.messageId}`;
    if(this.store.get('SELECT message_id FROM inbox WHERE message_id=?',inboxKey))return;
    const result=this.store.transaction(()=>{
    const explicit=targetFrom(message);
    const command=commandFrom(message.text);
    const event=eventFrom(message,this.config.intake);
    let result:string;
    if(event && !explicit && !command) {
      if(event.source==='wecom-request'&&!this.config.groups[message.groupId].owners.includes(message.senderId))return '仅配置的 Owner 可以主动发起排查。';
      const intake=this.engine.intake({...event,groupId:message.groupId,senderId:message.senderId,text:message.text});
      result=`任务 #${intake.task.id}：${intake.created?'已接收，等待调查':'已关联已有告警任务'}。`;
    } else {
      const candidates=this.engine.listTasks().filter(t=>t.groupId===message.groupId && !['closed','delivered'].includes(t.status));
      const task=explicit?this.engine.getTask(explicit.taskId):candidates.length===1?candidates[0]:undefined;
      if(!task) result=command||explicit?'请引用对应方案，或使用“任务 #编号 指令”明确目标。':'请补充 [告警:来源:事件ID]，或使用“排查 问题描述”发起调查。';
      else if(task.groupId!==message.groupId||!task.ownerIds.includes(message.senderId))result='仅任务所属群配置的 Owner 可以操作该任务。';
      else if(/(?:^|\s)(?:补充|信息|information)\s+\S/i.test(message.text)) {
        const response=this.engine.ownerInformation({taskId:task.id,groupId:message.groupId,senderId:message.senderId,text:message.text});
        result=`任务 #${task.id}：${response.accepted?'已保存补充信息，状态：'+response.task.status:'当前任务不接受补充信息'}。`;
      }
      else if(command==='confirm') {
        const response=this.engine.confirmNoCode({taskId:task.id,groupId:message.groupId,senderId:message.senderId});
        result=`任务 #${task.id}：${response.accepted?'已确认无需代码修复并关闭':'当前任务不等待关闭确认'}。`;
      } else {
        const response=this.engine.ownerCommand({taskId:task.id,planVersion:explicit?.planVersion??task.planVersion,groupId:message.groupId,senderId:message.senderId,command:command??'unknown'});
        result=`任务 #${task.id}：${response.accepted?response.task.status:`指令未执行（${response.reason}）`}。`;
      }
    }
    this.store.run('INSERT OR IGNORE INTO inbox(message_id,received_at) VALUES(?,?)',inboxKey,this.now());
    return result;
    });
    await this.deps.notify(message.groupId,result,[]);
  }

  async pump():Promise<void> {
    if(this.pumping||this.stopped)return;
    this.pumping=true;
    let finishPump!:()=>void;
    this.pumpDone=new Promise<void>(resolve=>{finishPump=resolve;});
    try {
      this.engine.tick();
      for(const effect of this.engine.outbox()) {
        if(this.stopped)break;
        const retry=this.store.get<{next_at:number}>('SELECT next_at FROM effect_retry WHERE effect_id=?',effect.id);
        if(retry && retry.next_at>this.now())continue;
        try {
          const handled=await this.effect(effect);
          if(handled){this.engine.ackEffect(effect.id);this.store.run('DELETE FROM effect_retry WHERE effect_id=?',effect.id);}
        } catch(error) {
          const count=(this.store.get<{attempts:number}>('SELECT attempts FROM effect_retry WHERE effect_id=?',effect.id)?.attempts??0)+1;
          this.store.run('INSERT OR REPLACE INTO effect_retry VALUES(?,?,?)',effect.id,this.now()+Math.min(300_000,1000*2**Math.min(count,8)),count);
          console.error(`Effect ${effect.id} (${effect.type}) failed:`,error instanceof Error?error.message:'unknown');
        }
      }
      if(!this.stopped&&this.now()>=this.pollAt){this.pollAt=this.now()+30_000;await this.pollDelivery();}
    } finally {this.pumping=false;finishPump();}
  }

  private async effect(effect:Effect):Promise<boolean> {
    const task=this.engine.getTask(effect.taskId);
    if(!task)return true;
    if(effect.type==='stop_run') {
      const running=this.active.get(task.id);
      if(running && running.runId===effect.payload.runId){running.controller.abort();await running.promise;}
      return true;
    }
    if(effect.type==='start_run') {
      if(task.status!=='running'||task.runId!==effect.payload.runId||task.runFence!==effect.payload.fence)return true;
      if(this.active.has(task.id))return false;
      const controller=new AbortController();
      const promise=Promise.resolve().then(()=>this.execute(task,effect,controller.signal)).finally(()=>this.active.delete(task.id));
      this.active.set(task.id,{runId:String(task.runId),controller,promise});
      return true;
    }
    const version=Number(effect.payload.planVersion??task.planVersion);
    const marker=`[告警方案:${task.id}:${version}]`;
    if(effect.type==='notify_plan') {
      if(task.planVersion!==version||!['plan_notify_pending','needs_owner'].includes(task.status))return true;
      await this.deps.notify(task.groupId,`${marker}\n${task.plan?.body??''}\n请回复同意、等一下、暂停或拒绝。首次通知后30分钟提醒，再等待30分钟仍无回复则执行。若涉及其他服务，请联系对应 Owner 共同查看。`,task.ownerIds);
      this.engine.recordNotification(task.id,version,'plan',true);
    } else if(effect.type==='send_reminder') {
      if(task.planVersion!==version||task.status!=='reminder_pending')return true;
      await this.deps.notify(task.groupId,`${marker}\n提醒：预计 ${new Date(this.now()+this.config.waitMs).toISOString()} 开始修复。回复同意、等一下、暂停或拒绝。`,task.ownerIds);
      this.engine.recordNotification(task.id,version,'reminder',true);
    } else if(effect.type==='notify_mr') {
      if(task.mrUrl!==effect.payload.mrUrl||task.headSha!==effect.payload.headSha)return true;
      await this.deps.notify(task.groupId,`任务 #${task.id} 已创建/更新 MR：${task.mrUrl}\n如涉及其他服务，请当前 Owner 联系对应 Owner 共同查看。等待当前版本审查与检查。`,task.ownerIds);
    } else {
      if(effect.type==='notify_no_code'&&task.status!=='no_code_wait')return true;
      if(effect.type==='notify_delivered'&&task.status!=='delivered')return true;
      if(effect.type==='notify_blocked'&&task.status!=='blocked')return true;
      const title=effect.type==='notify_no_code'?'无需代码修复，请回复“确认关闭”':effect.type==='notify_delivered'?'修复交付完成（不代表线上恢复）':'任务阻塞';
      await this.deps.notify(task.groupId,`任务 #${task.id} ${title}\n${JSON.stringify(effect.payload,null,2)}`,task.ownerIds);
    }
    return true;
  }

  private async execute(task:Task,effect:Effect,signal:AbortSignal):Promise<void> {
    const identity={taskId:task.id,runId:String(effect.payload.runId),fence:Number(effect.payload.fence),planVersion:Number(effect.payload.planVersion)};
    const valid=()=>{const current=this.engine.getTask(task.id);return !signal.aborted&&current?.status==='running'&&current.runId===identity.runId&&current.runFence===identity.fence&&current.planVersion===identity.planVersion;};
    try {
      const workspace=await this.deps.git.prepare(String(task.id),'fix',signal,task.headSha??undefined);
      if(!valid())return;
      this.store.run('INSERT INTO runtime(task_id,workspace) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET workspace=excluded.workspace',task.id,JSON.stringify(workspace));
      const fixing=effect.payload.phase==='fix';
      const prompt=[`任务 #${task.id}。阶段：${fixing?'执行已授权方案':'只读调查与临时复现，禁止修改业务代码'}。`,
        '遵循仓库规范。只能处理本任务，不查询其他任务或其他 MR。不得合并、部署、强推或执行生产写操作。',
        '提交修复方案或完成结果时使用提供的结构化工具。真实证据不足时如实说明，不编造测试和查询结果。',
        '如果需要人工或外部系统处理、缺少权限或其他条件导致不能完成，在 submit_completion.externalAction 写明所需操作，主服务将阻塞并通知 Owner。',
        fixing?'按当前方案修复、运行相关测试并提交本任务修改到当前分支；不要推送或创建MR，主服务会处理。实质扩大方案需先提交新方案停止执行。':'输出完整修复方案，或有证据的无需代码修复结论。',
        `原始请求：${JSON.stringify(this.engine.events(task.id))}`,
        task.plan?`当前方案：${JSON.stringify(task.plan)}`:'',task.blockReason?`上轮反馈：${task.blockReason}`:''].join('\n');
      const observations=new Set<string>();
      const result=await this.deps.runner.run({taskId:String(task.id),runId:identity.runId,planVersion:identity.planVersion,cwd:workspace.path,sessionPath:join(this.config.dataDir,'sessions',String(task.id)),phase:fixing?'execute':'investigate',prompt,signal,
        onEvent:event=>{
          if(event&&typeof event==='object') {
            const tool=event as Record<string,unknown>;
            if(tool.type==='tool_execution_end'&&!tool.isError&&typeof tool.toolName==='string'&&!tool.toolName.startsWith('submit_'))observations.add(createHash('sha256').update(JSON.stringify([tool.toolName,tool.result])).digest('hex'));
          }
          this.deps.trace?.(String(task.id),identity.runId,event);
        }});
      if(!valid())return;
      const actualHead=await this.deps.git.head(workspace.path);
      if(!valid())return;
      // Count observed tool results and Git state, not the model's rewritten evidence prose.
      const progressKey=createHash('sha256').update(JSON.stringify({head:actualHead,evidence:[...observations].sort()})).digest('hex');
      const prior=this.store.get<{progress_key:string|null}>('SELECT progress_key FROM runtime WHERE task_id=?',task.id)?.progress_key;
      const progress=progressKey!==prior&&(observations.size>0||actualHead!==workspace.head);
      this.store.run('UPDATE runtime SET progress_key=? WHERE task_id=?',progressKey,task.id);
      if('plan' in result) {
        this.engine.completeRun({...identity,progress,next:'plan',plan:{body:JSON.stringify(result.plan,null,2)}});
      } else if(result.completion.externalAction && !result.completion.noCodeChange) {
        this.engine.completeRun({...identity,progress,next:'blocked',reason:JSON.stringify(result.completion,null,2)});
      } else if(result.completion.noCodeChange) {
        this.engine.reportNoCode({...identity,conclusion:JSON.stringify(result.completion,null,2),externalAction:result.completion.externalAction});
      } else if(!fixing) {
        this.engine.completeRun({...identity,progress:false,next:'ready',reason:'Investigation did not return a plan or no-code conclusion'});
      } else {
        if(!valid())return;
        if(task.mrUrl&&actualHead===task.headSha){this.engine.completeRun({...identity,progress,next:'awaiting_checks',reason:'No new commit; waiting for current-head checks'});return;}
        const pushed=await this.deps.git.push(workspace,signal);
        if(!valid())return;
        const mr=await this.deps.delivery.createOrReadMergeRequest({sourceBranch:workspace.branch,title:`fix: alert task ${task.id}`,description:`任务 #${task.id}\n\n${task.plan?.body??''}\n\n${JSON.stringify(result.completion,null,2)}`},signal);
        if(!valid())return;
        this.store.run('UPDATE runtime SET mr_iid=? WHERE task_id=?',mr.iid,task.id);
        const recorded=this.engine.recordMr(task.id,{url:mr.url,branch:workspace.branch,headSha:pushed.head,state:mr.state==='merged'?'merged':mr.state==='closed'?'closed':'open',run:identity});
        if(!recorded.accepted)return;
      }
    } catch(error) {
      if(valid())this.engine.completeRun({...identity,progress:false,next:error instanceof GitWorkspaceConflictError||(error instanceof DeliveryHttpError&&[401,403,404].includes(error.status))?'blocked':'ready',reason:error instanceof Error?error.message:'Execution failed'});
      this.deps.trace?.(String(task.id),identity.runId,{type:'run_error',error:error instanceof Error?error.message:'Execution failed'});
    } finally {
      this.deps.trace?.(String(task.id),identity.runId,{type:'run_end',cancelled:signal.aborted});
    }
  }

  private async pollDelivery():Promise<void> {
    for(const task of this.engine.listTasks()) {
      if(this.stopped)return;
      const meta=this.store.get<{workspace:string|null;mr_iid:number|null;feedback_id:number}>('SELECT * FROM runtime WHERE task_id=?',task.id);
      if(!meta)continue;
      try {
        if(meta.mr_iid&&['awaiting_checks','delivered'].includes(task.status)) {
          const status=await this.deps.delivery.status(meta.mr_iid,task.headSha??undefined,this.stopping.signal);
          if(this.stopped)return;
          const state=status.mergeRequest.state==='merged'?'merged':status.mergeRequest.state==='closed'?'closed':'open';
          if(state!=='open') {
            this.engine.handleMrFeedback({taskId:task.id,mrUrl:status.mergeRequest.url,mrState:state,kind:'comment'});
          } else {
            if(!status.currentHead) {
              if(status.mergeRequest.sourceBranch!==task.branch)throw new Error('MR source branch changed unexpectedly');
              this.engine.recordMr(task.id,{url:status.mergeRequest.url,branch:status.mergeRequest.sourceBranch,headSha:status.mergeRequest.head});
            }
            const current=this.engine.getTask(task.id);
            const currentMr=this.store.get<{mr_iid:number|null}>('SELECT mr_iid FROM runtime WHERE task_id=?',task.id);
            if(this.deps.delivery.ensureAgentReview&&!status.ownerRequired&&(status.agentReviewStatus===undefined||status.agentReviewStatus==='pending')
              &&currentMr?.mr_iid===meta.mr_iid&&current?.headSha===status.mergeRequest.head&&['awaiting_checks','delivered'].includes(current.status)) {
              await this.deps.delivery.ensureAgentReview(meta.mr_iid,status.mergeRequest.head,this.stopping.signal);
              if(this.stopped)return;
            }
            if(status.ownerRequired) {
              // A conflict is an Owner decision, not a cue to inspect another task.
              const key=`conflict:${task.id}:${status.mergeRequest.head}`;
              if(!this.store.get('SELECT message_id FROM inbox WHERE message_id=?',key)){
                await this.deps.notify(task.groupId,`任务 #${task.id} 的 MR 存在冲突，请 Owner 协调：${task.mrUrl}`,task.ownerIds);
                this.store.run('INSERT INTO inbox VALUES(?,?)',key,this.now());
              }
            } else {
              const classify=(value:string|undefined):'passed'|'failed'|'pending'=>value==='success'?'passed':['failed','failure','error','canceled'].includes(value??'')?'failed':'pending';
              this.engine.recordMrChecks({taskId:task.id,headSha:status.mergeRequest.head,agentReview:classify(status.agentReviewStatus??(status.agentReviewPassed?'success':undefined)),requiredChecks:[...Object.values(status.checks).map(classify),status.mergeable?'passed':'pending']});
            }
            const feedback=await this.deps.delivery.feedback(meta.mr_iid,this.stopping.signal);
            if(this.stopped)return;
            this.store.transaction(()=>{
              for(const note of feedback.filter(n=>n.id>meta.feedback_id))this.engine.handleMrFeedback({taskId:task.id,mrUrl:status.mergeRequest.url,mrState:'open',kind:note.classification==='change-request'?'change_requested':'comment',body:note.body});
              if(feedback.length)this.store.run('UPDATE runtime SET feedback_id=? WHERE task_id=?',Math.max(meta.feedback_id,...feedback.map(n=>n.id)),task.id);
            });
          }
        }
        const current=this.engine.getTask(task.id)!;
        if(current.completedAt&&['closed','delivered'].includes(current.status)&&meta.workspace
          && await this.deps.git.cleanup(JSON.parse(meta.workspace) as GitWorkspace,current.completedAt,this.now())) {
          this.store.run('UPDATE runtime SET workspace=NULL WHERE task_id=?',task.id);
        }
      } catch(error){
        if(this.stopped)return;
        const reason=error instanceof Error?error.message:'Unknown MR observation failure';
        this.engine.blockObservation(task.id,task.headSha,reason);
        console.error(`Task ${task.id} observation failed:`,reason);
      }
    }
  }

  async shutdown():Promise<void> {
    this.stopped=true;this.stopping.abort();
    for(const active of this.active.values())active.controller.abort();
    await Promise.allSettled([this.pumpDone,...[...this.active.values()].map(x=>x.promise)]);
    this.engine.recoverRuns();
  }
}
