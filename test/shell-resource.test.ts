import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import register from '../src/pi/extension.ts';
const quote=(text:string)=>"'"+text.replaceAll("'","'\"'\"'")+"'";
function shell(command:string,args:string[]){
 const prior=process.env.PI_ALERT_SHELL_TOOL;
 try{process.env.PI_ALERT_SHELL_TOOL=JSON.stringify({command,args});const tools=new Map<string,any>();register({registerTool:t=>tools.set(t.name as string,t)});return tools.get('bash');}
 finally{if(prior===undefined)delete process.env.PI_ALERT_SHELL_TOOL;else process.env.PI_ALERT_SHELL_TOOL=prior;}
}

test('native bash wrapper preserves exact arguments, command and task cwd',async()=>{
 const root=await mkdtemp(join(tmpdir(),"shell ' wrapper-"));
 try{
  const capture=join(root,'args.json'), wrapper=join(root,'wrapper.mjs');
  await writeFile(wrapper,`import {writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';const [capture,...args]=process.argv.slice(2);writeFileSync(capture,JSON.stringify({args,cwd:process.cwd()}));const r=spawnSync(args[0],args.slice(1),{stdio:'inherit'});process.exit(r.status??1);`);
  const tool=shell(process.execPath,[wrapper,capture]);
  const literal="literal ' \" $HOME $(false) ; value";
  const command=`printf '%s' ${quote(literal)}`;
  const result=await tool.execute('call',{command},undefined,undefined,{cwd:root,sessionManager:{getSessionId:()=> 'fixture',getSessionFile:()=>undefined}});
  assert.equal(result.content[0].text,literal);
  assert.deepEqual(JSON.parse(await readFile(capture,'utf8')),{args:['/bin/bash','-c',command],cwd:await realpath(root)});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Linux shell gate serializes four commands and releases its lock after cancellation',{skip:process.platform!=='linux'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'shell-gate-'));
 try{
  const log=join(root,'events'),worker=join(root,'worker.mjs');
  await writeFile(worker,`import {appendFileSync} from 'node:fs';const [file,id]=process.argv.slice(2);appendFileSync(file,JSON.stringify({id,phase:'start',jobs:process.env.CMAKE_BUILD_PARALLEL_LEVEL})+'\\n');await new Promise(r=>setTimeout(r,100));appendFileSync(file,JSON.stringify({id,phase:'end'})+'\\n');`);
  const tool=shell('/bin/bash',[fileURLToPath(new URL('../scripts/limited-shell.sh',import.meta.url)),join(root,'shared.lock'),'2']);
  await Promise.all([1,2,3,4].map(id=>tool.execute(String(id),{command:[process.execPath,worker,log,String(id)].map(quote).join(' ')})));
  const rows=(await readFile(log,'utf8')).trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(rows.length,8);
  for(let i=0;i<rows.length;i+=2){assert.equal(rows[i].phase,'start');assert.equal(rows[i].jobs,'2');assert.deepEqual(rows[i+1],{id:rows[i].id,phase:'end'});}
  const started=join(root,'started'),controller=new AbortController();
  const running=tool.execute('cancel',{command:`printf ready > ${quote(started)}; sleep 30`},controller.signal);
  const cancelled=assert.rejects(running,/aborted/);
  for(let i=0;i<100;i++){try{await readFile(started);break;}catch{await new Promise(r=>setTimeout(r,20));}}
  assert.equal(await readFile(started,'utf8'),'ready');
  const queuedController=new AbortController(), queuedFile=join(root,'must-not-run');
  const queued=assert.rejects(tool.execute('queued-cancel',{command:`printf bad > ${quote(queuedFile)}`},queuedController.signal),/aborted/);
  await new Promise(r=>setTimeout(r,100));queuedController.abort();await queued;
  await assert.rejects(readFile(queuedFile),{code:'ENOENT'});
  controller.abort();await cancelled;
  const result=await tool.execute('after-cancel',{command:'printf released',timeout:3});assert.equal(result.content[0].text,'released');
 }finally{await rm(root,{recursive:true,force:true});}
});
