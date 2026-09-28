import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incomingFrame, targetFrom, commandFrom, eventFrom } from '../src/wecom.ts';

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
