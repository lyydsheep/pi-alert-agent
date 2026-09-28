import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandDeliveryClient } from '../src/delivery-command.ts';

const bridge = `
let input='';
process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
  const request=JSON.parse(input);
  const mr={iid:7,url:'https://git.example/mr/7',state:'opened',sourceBranch:'fix/task',targetBranch:'master',head:'head-1'};
  if(request.operation==='createOrReadMergeRequest')process.stdout.write(JSON.stringify(mr));
  if(request.operation==='status')process.stdout.write(JSON.stringify({mergeRequest:mr,currentHead:true,agentReviewPassed:true,agentReviewStatus:'success',checks:{build:'success'},mergeable:true,ownerRequired:false,complete:true}));
  if(request.operation==='ensureAgentReview')process.stdout.write(JSON.stringify({mrIid:request.mrIid,head:request.expectedHead}));
  if(request.operation==='feedback')process.stdout.write(JSON.stringify([{id:1,body:'change this',classification:'change-request'}]));
});`;

function client(script = bridge, timeoutMs = 1_000): CommandDeliveryClient {
  return new CommandDeliveryClient({command:process.execPath,args:['-e',script],project:'group/project',requiredChecks:['build'],agentReviewCheck:'Agent Review',timeoutMs});
}

test('command bridge supports the delivery contract and recomputes completion',async()=>{
  const delivery=client();
  assert.equal((await delivery.createOrReadMergeRequest({sourceBranch:'fix/task',title:'Fix',description:'Body'})).iid,7);
  assert.equal((await delivery.status(7,'head-1')).complete,true);
  assert.equal((await delivery.status(7,'different-head')).complete,false);
  assert.deepEqual(await delivery.ensureAgentReview(7,'head-1'),{mrIid:7,head:'head-1'});
  assert.equal((await delivery.feedback(7))[0].classification,'change-request');
});

test('command bridge rejects an Agent review receipt for another MR or head',async()=>{
  const delivery=client(`process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({mrIid:8,head:'other'})));`);
  await assert.rejects(()=>delivery.ensureAgentReview(7,'head-1'),/mismatched Agent review receipt/);
});

test('command bridge fails closed on missing status evidence and hides stderr',async()=>{
  const unsafe=client(`process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({mergeRequest:{iid:7,url:'u',state:'opened',sourceBranch:'s',targetBranch:'t',head:'h'},complete:true,checks:{}})));`);
  const status=await unsafe.status(7,'h');
  assert.equal(status.complete,false);
  assert.equal(status.ownerRequired,true);

  const failed=client(`process.stderr.write('secret-token');process.exit(2);`);
  await assert.rejects(()=>failed.feedback(7),error=>error instanceof Error&&/code 2/.test(error.message)&&!/secret-token/.test(error.message));
});

test('command bridge bounds output and execution time',async()=>{
  await assert.rejects(()=>client(`process.stdout.write('x'.repeat(1024*1024+1));`).feedback(7),/exceeded 1 MiB/);
  await assert.rejects(()=>client(`setInterval(()=>{},1000);`,20).feedback(7),/timed out/);
});
