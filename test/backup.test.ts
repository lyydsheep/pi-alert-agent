import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {backupData,restoreData} from '../src/backup.ts';

test('stopped service backup restores SQLite and session evidence without overwriting live data',async()=>{
  const root=await mkdtemp(join(tmpdir(),'alert-backup-'));const data=join(root,'data');const copy=join(root,'backup');await mkdir(data);
  try{
    const db=new DatabaseSync(join(data,'tasks.sqlite'));db.exec('CREATE TABLE tasks(id INTEGER); INSERT INTO tasks VALUES(42)');db.close();
    await mkdir(join(data,'sessions'));await writeFile(join(data,'sessions','task.jsonl'),'evidence');
    await backupData(data,copy);await assert.rejects(restoreData(copy,data));
    await rename(data,join(root,'old'));await restoreData(copy,data);
    const restored=new DatabaseSync(join(data,'tasks.sqlite'));assert.equal(restored.prepare('SELECT id FROM tasks').get()?.id,42);restored.close();
    assert.equal(await readFile(join(data,'sessions','task.jsonl'),'utf8'),'evidence');
    await mkdir(join(data,'service.lock'));await writeFile(join(data,'service.lock','pid'),String(process.pid));
    await assert.rejects(backupData(data,join(root,'running')),/Stop the service/);
  }finally{await rm(root,{recursive:true,force:true});}
});
