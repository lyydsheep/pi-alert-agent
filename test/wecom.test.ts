import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incomingFrame, targetFrom, commandFrom, eventFrom, sendGroup, MessageAmbiguityError } from '../src/wecom.ts';

test('authenticated origin, quoted plan and exact intent remain separate', () => {
  const message = incomingFrame({ body: { chattype:'group', msgtype:'text', chatid:'g', msgid:'m', from:{userid:'u'}, text:{content:'等一下'}, quote:{text:{content:'[告警方案:12:3]'}} } });
  assert.equal(message.senderId, 'u');
  assert.deepEqual(targetFrom(message), {taskId:12,planVersion:3});
  assert.equal(commandFrom(message.text), 'defer');
  assert.equal(commandFrom('他说同意'), undefined);
  assert.throws(() => incomingFrame({body:{...message, msgtype:'text'}}));
  assert.deepEqual(eventFrom({...message,text:'[告警:source:event-1] service failed'}), {source:'source',eventId:'event-1'});
  assert.equal(eventFrom({...message,text:'similar service failed'}), undefined);
  assert.notEqual(eventFrom({...message,text:'排查 故障'})?.eventId, eventFrom({...message,messageId:'m2',text:'排查 故障'})?.eventId);
});

test('rejects conflicting task IDs and plan versions instead of choosing a target', () => {
  const message = {messageId:'m', groupId:'g', senderId:'u', text:'任务 #2 同意', quote:'[告警方案:1:1]'};
  for (const [text, quote] of [
    [message.text, message.quote],
    ['任务 #1 task #2 同意', ''],
    ['[告警方案:1:2] 同意', '[告警方案:1:1]'],
    ['同意', '[告警方案:1:1] [告警方案:2:1]'],
    ['任务 #1 同意', '任务 #2 需要 Owner 介入'],
  ]) assert.throws(() => targetFrom({...message, text, quote}), MessageAmbiguityError);
  assert.deepEqual(targetFrom({...message,text:'任务 #1 同意'}), {taskId:1,planVersion:1});
  assert.deepEqual(targetFrom({...message,text:'[告警方案:1:1] 任务 #1 同意'}), {taskId:1,planVersion:1});
  assert.deepEqual(targetFrom({...message,text:'同意'}), {taskId:1,planVersion:1});
});

test('quoted alerts preserve event identity and conflicting identities are rejected', () => {
  const message = {messageId:'m', groupId:'g', senderId:'u', text:'排查 这个告警', quote:'[告警:source:event-1] service failed'};
  assert.deepEqual(eventFrom(message), {source:'source',eventId:'event-1'});
  assert.deepEqual(eventFrom({...message,text:'[告警:source:event-1] 排查'}), {source:'source',eventId:'event-1'});
  for (const text of ['[告警:source:event-2] 排查', '[告警:other:event-1] 排查']) {
    assert.throws(() => eventFrom({...message,text}), MessageAmbiguityError);
  }
  assert.throws(() => eventFrom({...message,quote:'[告警:source:event-1] [告警:source:event-2]'}), MessageAmbiguityError);
  const config = {source:'monitor',eventIdPattern:'event=(?<eventId>[a-z0-9-]+)'};
  assert.deepEqual(eventFrom({...message,quote:'event=original-1'},config), {source:'monitor',eventId:'original-1'});
  assert.throws(() => eventFrom({...message,text:'event=other',quote:'event=original-1'},config), MessageAmbiguityError);
  assert.throws(() => eventFrom({...message,text:'[告警:monitor:other] 排查',quote:'event=original-1'},config), MessageAmbiguityError);
  assert.equal(eventFrom({...message,text:'同意',quote:'[告警方案:1:1]'}), undefined);
});

test('removes only the configured leading bot mention before parsing Owner commands', () => {
  const message = (text:string) => incomingFrame({body:{chattype:'group',msgtype:'text',chatid:'g',msgid:'m',from:{userid:'u'},text:{content:text}}}, '@Test Agent');
  for (const separator of [' ', '\n']) {
    const received = message(`@Test Agent${separator}任务 #1 重试`);
    assert.equal(commandFrom(received.text), 'resume');
    assert.deepEqual(targetFrom(received), {taskId:1});
    assert.equal(received.senderId, 'u');
  }
  assert.equal(commandFrom(message('@Other Agent\n任务 #1 重试').text), undefined);
  assert.equal(commandFrom(message('@Test AgentExtra\n任务 #1 重试').text), undefined);
});


test('group notification preserves content and requests Owner mentions on the final chunk',async t=>{
  const requests:Array<{msgtype:string;text:{content:string;mentioned_list:string[]}}>=[];
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({errcode:0}));
  });
  const content='需要 Owner 介入\n'.repeat(300);
  await sendGroup('https://wecom.test/webhook',content,['owner']);
  assert.ok(requests.length>1);assert.equal(requests.map(r=>r.text.content).join(''),content);
  for(const [i,r] of requests.entries()){
    assert.equal(r.msgtype,'text');assert.ok(Buffer.byteLength(r.text.content)<=1800);
    assert.deepEqual(r.text.mentioned_list,i===requests.length-1?['owner']:[]);
  }
});
