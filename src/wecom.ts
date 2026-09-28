import { createHash } from 'node:crypto';

export interface IncomingMessage {
  messageId: string; groupId: string; senderId: string; text: string; quote: string;
}
export type OwnerCommand = 'approve' | 'defer' | 'pause' | 'reject' | 'resume' | 'unknown' | 'confirm';

// Only call with a frame received on the authenticated bot connection.
export function incomingFrame(frame: unknown): IncomingMessage {
  const body = (frame as { body?: Record<string, any> })?.body;
  if (!body || body.chattype !== 'group' || body.msgtype !== 'text' ||
      typeof body.chatid !== 'string' || !body.chatid ||
      typeof body.msgid !== 'string' || !body.msgid ||
      typeof body.from?.userid !== 'string' || !body.from.userid ||
      typeof body.text?.content !== 'string') throw new Error('Unsupported or incomplete authenticated message');
  return { messageId: body.msgid, groupId: body.chatid, senderId: body.from.userid,
    text: body.text.content, quote: typeof body.quote?.text?.content === 'string' ? body.quote.text.content : '' };
}

export function commandFrom(text: string): OwnerCommand | undefined {
  const value = text.replace(/\[告警方案:\d+:\d+\]/g, '').replace(/(?:任务|task)\s*#?\d+/gi, '').trim();
  if (/^(同意|批准|approve)$/i.test(value)) return 'approve';
  if (/^(等一下|稍等|延期|defer)$/i.test(value)) return 'defer';
  if (/^(暂停|停止|pause)$/i.test(value)) return 'pause';
  if (/^(拒绝|不同意|reject)$/i.test(value)) return 'reject';
  if (/^(恢复|继续|重试|resume)$/i.test(value)) return 'resume';
  if (/^(确认关闭|无需修复确认|confirm)$/i.test(value)) return 'confirm';
  return undefined;
}

export function targetFrom(message: IncomingMessage): { taskId: number; planVersion?: number } | undefined {
  const match = `${message.text}\n${message.quote}`.match(/\[告警方案:(\d+):(\d+)\]/);
  if (match) return { taskId: Number(match[1]), planVersion: Number(match[2]) };
  const id = message.text.match(/(?:任务|task)\s*#?(\d+)/i);
  return id ? { taskId: Number(id[1]) } : undefined;
}

export function eventFrom(message: IncomingMessage, config?:{source:string;eventIdPattern:string}): { source: string; eventId: string } | undefined {
  // Explicit event identities only. Similar prose is never a deduplication key.
  const identity = message.text.match(/\[告警:([^:\]\s]+):([^\]\s]+)\]/);
  if (identity) return { source: identity[1], eventId: identity[2] };
  if(config){const id=new RegExp(config.eventIdPattern).exec(message.text)?.groups?.eventId;if(id)return {source:config.source,eventId:id};}
  if (/^(排查|调查|investigate)\s+/i.test(message.text)) {
    return { source: 'wecom-request', eventId: createHash('sha256').update(`${message.groupId}\0${message.messageId}`).digest('hex') };
  }
  return undefined;
}

export async function sendGroup(webhook: string, content: string, owners: string[], signal?: AbortSignal): Promise<void> {
  const url = new URL(webhook);
  if (url.protocol !== 'https:') throw new Error('Group webhook must use HTTPS');
  // Text messages have a byte limit. Preserve the complete content in ordered chunks.
  const chunks: string[] = []; let chunk = '';
  for (const point of content) {
    if (Buffer.byteLength(chunk + point, 'utf8') > 1800) { chunks.push(chunk); chunk = ''; }
    chunk += point;
  }
  if (chunk) chunks.push(chunk);
  for (let index = 0; index < chunks.length; index++) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: chunks[index], mentioned_list: index === chunks.length - 1 ? owners : [] } }),
      signal: signal ?? AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`WeCom HTTP ${response.status}`);
    const result = await response.json() as { errcode?: number };
    if (result.errcode !== 0) throw new Error(`WeCom rejected notification: ${result.errcode ?? 'missing status'}`);
  }
}
