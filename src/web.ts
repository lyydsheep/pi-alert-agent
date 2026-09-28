import { createServer, type Server } from 'node:http';
import type { Task } from './engine.ts';
import { parseReport, statusLabel, reportSummary } from './report.ts';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const safeUrl = (value?: string | null) => value && /^https?:\/\//i.test(value) ? escape(value) : undefined;
const time = (value: number) => new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'short',hour12:false}).format(value);

const css = `
  :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#fff;color:#202124;font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}
  main,header{width:min(820px,calc(100% - 36px));margin:auto}header{padding:34px 0 20px;border-bottom:1px solid #e8eaed}main{padding:14px 0 64px}
  h1{margin:0 0 8px;font-size:30px;line-height:1.3;font-weight:600}h2{margin:34px 0 10px;font-size:20px;font-weight:600}h3{margin:0;font-size:18px;font-weight:600}
  p{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}a{color:#185abc;text-decoration:none}a:hover{text-decoration:underline}.muted,small{color:#5f6368}
  article{padding:20px 0;border-bottom:1px solid #e8eaed}.meta{display:flex;gap:8px 18px;flex-wrap:wrap;color:#5f6368}.status{color:#137333;font-weight:600}
  ul{margin:8px 0;padding-left:24px}li{margin:5px 0;overflow-wrap:anywhere}.notice{margin:20px 0;padding:12px 16px;background:#f8f9fa;border-left:3px solid #dadce0}
  .links{display:flex;gap:18px;flex-wrap:wrap;margin-top:18px}@media(max-width:560px){header{padding-top:24px}h1{font-size:25px}h2{margin-top:28px}}
`;

const page = (title: string, header: string, body: string, refresh = false) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh?'<meta http-equiv="refresh" content="15">':''}<title>${escape(title)}</title><style>${css}</style></head><body><header>${header}</header><main>${body}</main></body></html>`;

export function dashboard(tasks: Task[], phoenixUrl?: string): string {
  const trace = safeUrl(phoenixUrl);
  return page('告警任务', `<h1>告警任务</h1><p class="muted">查看进度与调查报告。操作请在企微群回复对应方案。</p>${trace?`<a href="${trace}" rel="noreferrer">查看执行追踪</a>`:''}`,
    tasks.length ? tasks.map(task => `<article><h3><a href="/tasks/${task.id}?version=${task.planVersion}">任务 #${task.id} · ${escape(task.source)} / ${escape(task.eventId)}</a></h3>
      <div class="meta"><span class="status">${escape(statusLabel(task.status))}</span><span>负责人：${escape(task.ownerIds.join('、')||'未配置')}</span><span>方案版本：${task.planVersion}</span></div>
      ${task.waitUntil?`<p>等待截止：${escape(time(task.waitUntil))}（北京时间）</p>`:''}${task.blockReason?`<p>阻塞原因：${escape(task.blockReason)}</p>`:''}
      <small>最近更新：${escape(time(task.updatedAt))}（北京时间）</small></article>`).join('') : '<p>暂无任务</p>', true);
}

function values(report: Record<string, unknown>, key: string): string[] {
  const value = report[key];
  return Array.isArray(value) ? value.map(item => String(item)) : value == null || value === '' ? [] : [String(value)];
}

function section(report: Record<string, unknown>, key: string, title: string): string {
  const content = values(report, key);
  return `<section><h2>${title}</h2>${content.length > 1 ? `<ul>${content.map(item=>`<li>${escape(item)}</li>`).join('')}</ul>` : `<p>${escape(content[0]??'暂无')}</p>`}</section>`;
}

function completionSection(report: Record<string, unknown>): string {
  const summary = values(report, 'summary')[0];
  const evidence = values(report, 'evidence');
  const tests = values(report, 'tests');
  const externalAction = values(report, 'externalAction')[0];
  if (!summary && !evidence.length && !tests.length && !externalAction) return '';
  const list = (title: string, items: string[]) => items.length ? `<h3>${title}</h3><ul>${items.map(item=>`<li>${escape(item)}</li>`).join('')}</ul>` : '';
  return `<section><h2>处理结论</h2>${summary?`<p>${escape(summary)}</p>`:''}${list('结论证据',evidence)}${list('验证结果',tests)}${externalAction?`<h3>后续操作</h3><p>${escape(externalAction)}</p>`:''}</section>`;
}

export function taskReport(task: Task, report: Record<string, unknown> = parseReport(task.plan?.body??task.conclusion??''), phoenixUrl?: string): string {
  const mr = task.mrUrl && /^https:\/\//i.test(task.mrUrl) ? escape(task.mrUrl) : undefined;
  const trace = safeUrl(phoenixUrl);
  const note = values(report, 'displayNote')[0];
  const completionReport = task.conclusion ? (task.plan ? parseReport(task.conclusion) : report) : {};
  const summary = values(report, 'summary')[0] ?? values(completionReport, 'summary')[0] ?? reportSummary(report);
  const planSections = task.plan ? `${section(report,'background','背景')}${section(report,'diagnosis','诊断')}${section(report,'evidence','证据')}${section(report,'scope','影响范围')}${section(report,'solution','解决方案')}${section(report,'acceptance','验收标准')}${section(report,'risks','风险')}` : '';
  const completion = task.conclusion ? completionSection(completionReport) : '';
  return page(`任务 #${task.id}`, `<a href="/">← 返回任务列表</a><h1>任务 #${task.id}</h1><div class="meta"><span class="status">${escape(statusLabel(task.status))}</span><span>${escape(task.source)} / ${escape(task.eventId)}</span></div>`,
    `${note?`<p class="notice">${escape(note)}</p>`:''}<section><h2>摘要</h2><p>${escape(summary)}</p></section>
    ${planSections}${completion}
    ${task.blockReason?`<section><h2>阻塞原因</h2><p>${escape(task.blockReason)}</p></section>`:''}
    <section><h2>任务信息</h2><div class="meta"><span>负责人：${escape(task.ownerIds.join('、')||'未配置')}</span><span>方案版本：${task.planVersion}</span><span>最近更新：${escape(time(task.updatedAt))}（北京时间）</span>${task.waitUntil?`<span>等待截止：${escape(time(task.waitUntil))}（北京时间）</span>`:''}</div>
    <div class="links">${mr?`<a href="${mr}" rel="noreferrer">查看 MR</a>`:''}${trace?`<a href="${trace}" rel="noreferrer">查看执行追踪</a>`:''}</div></section>
    <p class="muted">线上恢复：未确认。代码交付不代表线上恢复。</p>
    <p class="notice">如需同意、等一下、暂停或拒绝，请回到企微群回复对应方案。</p>`);
}

export function createDashboard(getTasks: () => Task[], options: {phoenixUrl?: string; getReport?: (task: Task) => Record<string, unknown>} = {}): Server {
  return createServer((request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, {'allow':'GET, HEAD'}).end(); return; }
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') { response.writeHead(200, {'content-type':'application/json'}).end(request.method === 'HEAD' ? undefined : '{"ok":true}'); return; }
    try {
      const tasks = getTasks();
      if (url.pathname === '/api/tasks') { response.writeHead(200, {'content-type':'application/json; charset=utf-8'}).end(request.method === 'HEAD' ? undefined : JSON.stringify(tasks)); return; }
      if (url.pathname === '/') { response.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end(request.method === 'HEAD' ? undefined : dashboard(tasks, options.phoenixUrl)); return; }
      const match = /^\/tasks\/(\d+)$/.exec(url.pathname);
      if (!match) { response.writeHead(404).end(); return; }
      const task = tasks.find(candidate => candidate.id === Number(match[1]));
      if (!task) { response.writeHead(404).end(); return; }
      const requested = url.searchParams.get('version');
      if (requested !== null && (!/^\d+$/.test(requested) || Number(requested) !== task.planVersion)) {
        response.writeHead(409, {'content-type':'text/html; charset=utf-8'}).end(request.method === 'HEAD' ? undefined : page('方案版本已更新','<a href="/">← 返回任务列表</a><h1>方案版本已更新</h1>',`<p>请求的方案版本 ${escape(requested)} 与当前版本 ${task.planVersion} 不一致。</p><p><a href="/tasks/${task.id}?version=${task.planVersion}">查看当前方案</a></p>`));
        return;
      }
      const report = options.getReport?.(task) ?? parseReport(task.plan?.body??task.conclusion??'');
      response.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end(request.method === 'HEAD' ? undefined : taskReport(task, report, options.phoenixUrl));
    } catch { response.writeHead(503).end('Task state temporarily unavailable'); }
  });
}
