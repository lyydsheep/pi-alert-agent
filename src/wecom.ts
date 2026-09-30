import { createHash } from 'node:crypto';

export interface IncomingMessage {
  messageId: string; groupId: string; senderId: string; text: string; quote: string;
}
export type OwnerCommand = 'approve' | 'defer' | 'pause' | 'reject' | 'resume' | 'unknown' | 'confirm';

export class MessageAmbiguityError extends Error {}

// Only call with a frame received on the authenticated bot connection.
export function incomingFrame(frame: unknown, botMention?: string): IncomingMessage {
  const body = (frame as { body?: Record<string, any> })?.body;
  if (!body || body.chattype !== 'group' || body.msgtype !== 'text' ||
      typeof body.chatid !== 'string' || !body.chatid ||
      typeof body.msgid !== 'string' || !body.msgid ||
      typeof body.from?.userid !== 'string' || !body.from.userid ||
      typeof body.text?.content !== 'string') throw new Error('Unsupported or incomplete authenticated message');
  let text = body.text.content.trimStart();
  if (botMention && text.startsWith(botMention) && (text.length === botMention.length || /^\s/.test(text.slice(botMention.length)))) {
    text = text.slice(botMention.length).trimStart();
  }
  return { messageId: body.msgid, groupId: body.chatid, senderId: body.from.userid,
    text, quote: typeof body.quote?.text?.content === 'string' ? body.quote.text.content : '' };
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
  const content = `${message.text}\n${message.quote}`;
  const markers = [...content.matchAll(/\[告警方案:(\d+):(\d+)\]/g)];
  const ids = new Set([...markers.map(match => Number(match[1])),
    ...[...content.matchAll(/(?:任务|task)\s*#?(\d+)/gi)].map(match => Number(match[1]))]);
  const versions = new Set(markers.map(match => Number(match[2])));
  if ([...ids, ...versions].some(value => !Number.isSafeInteger(value)) || [...ids].some(value => value < 1)) {
    throw new MessageAmbiguityError('任务编号或方案版本无效，请引用有效方案。');
  }
  if (ids.size > 1 || versions.size > 1) {
    throw new MessageAmbiguityError('消息与引用中的任务编号或方案版本不一致，请明确唯一目标。');
  }
  const taskId = [...ids][0];
  return taskId === undefined ? undefined : versions.size ? { taskId, planVersion: [...versions][0] } : { taskId };
}

export function eventFrom(message: IncomingMessage, config?:{source:string;eventIdPattern:string}): { source: string; eventId: string } | undefined {
  // Explicit event identities only. Similar prose is never a deduplication key.
  const identities: Array<{ source: string; eventId: string }> = [];
  for (const content of [message.text, message.quote]) {
    const markers = [...content.matchAll(/\[告警:([^:\]\s]+):([^\]\s]+)\]/g)];
    identities.push(...markers.map(match => ({ source: match[1], eventId: match[2] })));
    if (!markers.length && config) {
      for (const match of content.matchAll(new RegExp(config.eventIdPattern, 'g'))) {
        if (match.groups?.eventId) identities.push({ source: config.source, eventId: match.groups.eventId });
      }
    }
  }
  const identity = identities[0];
  if (identities.some(value => value.source !== identity?.source || value.eventId !== identity?.eventId)) {
    throw new MessageAmbiguityError('消息与引用中的告警来源或事件编号不一致，请明确唯一告警。');
  }
  if (identity) return identity;
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
