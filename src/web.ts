import { createServer, type Server } from 'node:http';
import type { Task } from './engine.ts';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

export function dashboard(tasks: Task[], phoenixUrl?: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><title>告警任务</title>
  <style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#202124;background:#f8f9fa}article{background:white;border:1px solid #dadce0;border-radius:12px;margin:20px 0;padding:24px}h1,h2{font-weight:500}p{line-height:1.6}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f8f9fa;padding:16px}a{color:#1967d2}small{color:#5f6368}.status{font-weight:600}</style>
  <header><h1>告警任务</h1><p>进度与证据 · 操作请在企微群回复对应方案</p>${phoenixUrl ? `<a href="${escape(phoenixUrl)}" rel="noreferrer">查看执行追踪</a>` : ''}</header>
  ${tasks.length ? tasks.map(task => `<article><h2>任务 #${task.id} · ${escape(task.source)} / ${escape(task.eventId)}</h2>
  <p class="status">${escape(task.status)}</p><p>Owner：${escape(task.ownerIds.join(', ') || '未配置')} · 方案版本 ${task.planVersion}</p>
  ${task.waitUntil ? `<p>当前等待截止：${escape(new Date(task.waitUntil).toISOString())}</p>` : ''}
  ${task.blockReason ? `<p>阻塞：${escape(task.blockReason)}</p>` : ''}
  ${task.plan ? `<details><summary>修复方案与证据</summary><pre>${escape(task.plan.body)}</pre></details>` : ''}
  ${task.conclusion ? `<pre>${escape(task.conclusion)}</pre>` : ''}
  ${task.mrUrl && /^https:\/\//.test(task.mrUrl) ? `<p><a href="${escape(task.mrUrl)}" rel="noreferrer">查看 MR</a></p>` : ''}
  <small>线上恢复：未确认（代码交付不等于线上恢复） · 最近更新 ${escape(new Date(task.updatedAt).toISOString())}</small></article>`).join('') : '<p>暂无任务</p>'}</html>`;
}

export function createDashboard(getTasks: () => Task[], options: {phoenixUrl?: string} = {}): Server {
  return createServer((request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, {'allow':'GET, HEAD'}).end(); return; }
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') { response.writeHead(200, {'content-type':'application/json'}).end('{"ok":true}'); return; }
    if (url.pathname !== '/' && url.pathname !== '/api/tasks') { response.writeHead(404).end(); return; }
    try {
      const tasks = getTasks();
      response.writeHead(200, {'content-type':url.pathname === '/' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'});
      response.end(request.method === 'HEAD' ? undefined : url.pathname === '/' ? dashboard(tasks, options.phoenixUrl) : JSON.stringify(tasks));
    } catch { response.writeHead(503).end('Task state temporarily unavailable'); }
  });
}
