import test from 'node:test';
import assert from 'node:assert/strict';
import register from '../src/pi/extension.ts';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const quote=(text:string)=>"'"+text.replaceAll("'","'\"'\"'")+"'";

test('bash trace details retain full successful and failed output beyond the native model limit',async()=>{
 const hooks=new Map<string,any>(),tools=new Map<string,any>();
  register({registerTool:t=>tools.set(t.name as string,t),on:(event:any,handler:any)=>{hooks.set(event,handler);}});
  const tool=tools.get('bash'), payload='BEGIN\n'+'界'.repeat(40_000)+'\nEND';
  for(const exitCode of [0,3]){
   const id='large-'+exitCode;let result:any,isError=false;
   try{result=await tool.execute(id,{command:[process.execPath,'-e',`process.stdout.write(${JSON.stringify(payload)});process.exitCode=${exitCode}`].map(quote).join(' ')});}
   catch(error){isError=true;result={content:[{type:'text',text:(error as Error).message}]};}
   assert.equal(isError,exitCode!==0);
   assert.ok(Buffer.byteLength(result.content[0].text)<Buffer.byteLength(payload));
   const extra=hooks.get('tool_result')?.({toolName:'bash',toolCallId:id,details:result.details,isError});
   assert.ok(extra?.details?.fullOutput===payload,'full output must match including both markers and Unicode bytes');
   assert.equal(hooks.get('tool_result')?.({toolName:'bash',toolCallId:id}),undefined,'captured output is consumed once');
  }
});

test('non UTF-8 output retains exact raw bytes in bounded trace chunks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-binary-output-')),trace=join(root,'trace.jsonl'),fd=openSync(trace,'w');
 const previous={TMPDIR:process.env.TMPDIR,PI_ALERT_TRACE_FD:process.env.PI_ALERT_TRACE_FD};
 try{
  process.env.TMPDIR=root;process.env.PI_ALERT_TRACE_FD=String(fd);
  const tools=new Map<string,any>(),hooks=new Map<string,any>();
  register({registerTool:t=>tools.set(t.name as string,t),on:(event:any,handler:any)=>hooks.set(event,handler)});
  const command=[process.execPath,'-e','process.stdout.write(Buffer.alloc(200000,255))'].map(quote).join(' ');
  await tools.get('bash').execute('binary',{command});
  const details=hooks.get('tool_result')({toolName:'bash',toolCallId:'binary'}).details;
  const chunks=readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(e=>e.type==='pi_tool_output');
  assert.ok(chunks.every(e=>Buffer.byteLength(e.data)<=32*1024));
  assert.deepEqual(Buffer.concat(chunks.filter(e=>e.rawBytesBase64).map(e=>Buffer.from(e.rawBytesBase64,'base64'))),Buffer.alloc(200000,255));
  assert.deepEqual(readFileSync(details.fullOutputPath),Buffer.alloc(200000,255));
  assert.equal(details.fullOutput,undefined,'decoded data larger than inline limit stays in artifact');
 }finally{
  closeSync(fd);for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  rmSync(root,{recursive:true,force:true});
 }
});

test('query cancellation terminates descendants that inherit output pipes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-query-tree-')),ready=join(root,'ready'),heartbeat=join(root,'heartbeat');
 const previous={TMPDIR:process.env.TMPDIR,PI_ALERT_ALERT_TOOL:process.env.PI_ALERT_ALERT_TOOL};
 try{
  process.env.TMPDIR=root;
  const producer=`const fs=require('fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),5);`;
  const wrapper=`const {spawn}=require('child_process'),fs=require('fs');spawn(process.execPath,['-e',${JSON.stringify(producer)}],{stdio:['ignore','inherit','inherit']});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
  process.env.PI_ALERT_ALERT_TOOL=JSON.stringify({command:process.execPath,args:['-e',wrapper]});
  const tools=new Map<string,any>();register({registerTool:t=>tools.set(t.name as string,t),on:()=>{}});
  const controller=new AbortController(),pending=tools.get('query_alert').execute('tree',{query:'query'},controller.signal);
  for(let i=0;i<100;i++){try{readFileSync(heartbeat);break;}catch{await new Promise(r=>setTimeout(r,10));}}
  assert.equal(readFileSync(ready,'utf8'),'ready');
  controller.abort();await assert.rejects(pending,/cancelled/);
  const last=readFileSync(heartbeat,'utf8');await new Promise(r=>setTimeout(r,100));
  assert.equal(readFileSync(heartbeat,'utf8'),last);
 }finally{
  for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  rmSync(root,{recursive:true,force:true});
 }
});

test('an output flood stops at the byte ceiling and retains its partial artifact',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-output-limit-')),previous=process.env.TMPDIR;
 try{
  process.env.TMPDIR=root;
  const hooks=new Map<string,any>(),tools=new Map<string,any>();
  register({registerTool:t=>tools.set(t.name as string,t),on:(event:any,handler:any)=>{hooks.set(event,handler);}});
  const command=[process.execPath,'-e',"for(let i=0;i<70;i++)process.stdout.write(Buffer.alloc(1024*1024,120))"].map(quote).join(' ');
  await assert.rejects(tools.get('bash').execute('flood',{command}),/output exceeds/);
  const details=hooks.get('tool_result')({toolName:'bash',toolCallId:'flood'}).details;
  assert.equal(details.fullOutput,undefined);
  assert.ok(details.fullOutputBytes<=64*1024*1024);
  assert.equal(statSync(details.fullOutputPath).size,details.fullOutputBytes);
 }finally{if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;rmSync(root,{recursive:true,force:true});}
});

test('large bash and adapter results stay on disk with complete ordered trace chunks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-output-check-')),trace=join(root,'trace.jsonl'),fd=openSync(trace,'w');
 const previous={TMPDIR:process.env.TMPDIR,PI_ALERT_TRACE_FD:process.env.PI_ALERT_TRACE_FD,PI_ALERT_ALERT_TOOL:process.env.PI_ALERT_ALERT_TOOL};
 try{
  process.env.TMPDIR=root;process.env.PI_ALERT_TRACE_FD=String(fd);
  const source="process.stdout.write('界'.repeat(150000)+'END')";
  process.env.PI_ALERT_ALERT_TOOL=JSON.stringify({command:process.execPath,args:['-e',source]});
  const hooks=new Map<string,any>(),tools=new Map<string,any>();
  register({registerTool:t=>tools.set(t.name as string,t),on:(event:any,handler:any)=>{hooks.set(event,handler);}});
  const expected='界'.repeat(150000)+'END';
  const bash=await tools.get('bash').execute('large-bash',{command:[process.execPath,'-e',source].map(quote).join(' ')});
  const details=hooks.get('tool_result')({toolName:'bash',toolCallId:'large-bash',details:bash.details}).details;
  const query=await tools.get('query_alert').execute('large-query',{query:'anything'});
  for(const value of [details,query.details]){
   assert.equal(value.fullOutput,undefined);
   assert.equal(value.fullOutputBytes,Buffer.byteLength(expected));
   assert.equal(value.fullOutputSha256,createHash('sha256').update(expected).digest('hex'));
   assert.equal(readFileSync(value.fullOutputPath,'utf8'),expected);
   assert.equal(statSync(value.fullOutputPath).mode&0o777,0o600);
  }
  assert.ok(Buffer.byteLength(query.content[0].text)<1024);
  const events=readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  for(const id of ['large-bash','large-query']){
   const chunks=events.filter(event=>event.toolCallId===id&&event.stream!=='stderr');
   assert.equal(chunks.map(chunk=>chunk.data).join(''),expected);
   assert.ok(chunks.every((chunk,i)=>chunk.sequence===i&&Buffer.byteLength(chunk.data)<=16*1024+3));
  }
 }finally{
  closeSync(fd);
  for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  rmSync(root,{recursive:true,force:true});
 }
});
