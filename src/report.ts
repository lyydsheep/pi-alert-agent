import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from './engine.ts';

export function parseReport(body:string):Record<string,unknown> {
  let value:unknown=body;
  for(let depth=0;depth<4;depth++) {
    if(typeof value==='string') {try{value=JSON.parse(value);}catch{return {summary:value};}}
    if(!value||typeof value!=='object'||Array.isArray(value))return {};
    const record=value as Record<string,unknown>;
    if(typeof record.body==='string'){value=record.body;continue;}
    return record;
  }
  return {};
}

export function loadReport(task:Task,dataDir:string):Record<string,unknown> {
  const body=task.plan?.body??task.conclusion??'';
  try {
    const saved=JSON.parse(readFileSync(join(dataDir,'reports',`${task.id}-${task.planVersion}.json`),'utf8'));
    const hash=createHash('sha256').update(body).digest('hex');
    if(saved.sourceBodyHash===hash&&saved.report&&typeof saved.report==='object'&&!Array.isArray(saved.report))
      return {...saved.report,displayNote:'中文展示译文；原始方案内容与版本保持不变。'};
  } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')console.error('Report translation unavailable for task',task.id);}
  return parseReport(body);
}

export function reportUrl(task:Task,base?:string):string|undefined {
  return base?new URL(`tasks/${task.id}?version=${task.planVersion}`,base.endsWith('/')?base:`${base}/`).href:undefined;
}

export function reportSummary(report:Record<string,unknown>):string {
  const value=report.summary??report.diagnosis??report.background;
  if(typeof value!=='string')return '调查结果已整理，请查看完整报告。';
  const points=Array.from(value.replace(/\s+/g,' ').trim());
  return points.length>180?points.slice(0,180).join('')+'…':points.join('');
}

export function statusLabel(status:string):string {
  return ({queued:'等待调查',running:'处理中',plan_notify_pending:'方案待通知',awaiting_owner:'等待 Owner 确认',reminder_pending:'等待发送提醒',needs_owner:'需要配置 Owner',needs_confirmation:'等待明确指令',paused:'已暂停',rejected:'已拒绝',ready:'等待执行',awaiting_checks:'等待审查与检查',no_code_wait:'等待确认无需修复',blocked:'需要 Owner 介入',delivered:'代码已交付',closed:'已关闭'} as Record<string,string>)[status]??status;
}
