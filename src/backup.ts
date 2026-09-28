import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';

async function assertStopped(dataDir:string):Promise<void> {
  let raw:string;
  try{raw=await readFile(join(dataDir,'service.lock','pid'),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  const pid=Number(raw);if(!Number.isSafeInteger(pid)||pid<1)throw new Error('Invalid lock; inspect service state');
  try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw error;}
  throw new Error('Stop the service before backup or restore');
}

export async function backupData(dataDir:string,destination:string):Promise<void> {
  dataDir=resolve(dataDir);destination=resolve(destination);
  const rel=relative(dataDir,destination);
  if(!rel||(!rel.startsWith('..')&&!isAbsolute(rel)))throw new Error('Backup destination must be outside data directory');
  await assertStopped(dataDir);
  await mkdir(destination,{recursive:false,mode:0o700});
  try {
    const db=new DatabaseSync(join(dataDir,'tasks.sqlite'),{readOnly:true});
    try{await sqliteBackup(db,join(destination,'tasks.sqlite'));}finally{db.close();}
    for(const item of await readdir(dataDir,{withFileTypes:true})) {
      if(item.name==='service.lock'||item.name.startsWith('tasks.sqlite'))continue;
      await cp(join(dataDir,item.name),join(destination,item.name),{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true});
    }
    await writeFile(join(destination,'backup.json'),JSON.stringify({format:1,dataDir,createdAt:new Date().toISOString(),scope:'same-host; target business repository and task refs must be retained separately'},null,2),{mode:0o600});
  } catch(error){await rm(destination,{recursive:true,force:true});throw error;}
}

export async function restoreData(source:string,dataDir:string):Promise<void> {
  const metadata=JSON.parse(await readFile(join(source,'backup.json'),'utf8'));
  if(metadata.format!==1||metadata.dataDir!==resolve(dataDir))throw new Error('Restore requires the original data path and retained business repository');
  await assertStopped(dataDir);
  // Refuse to overwrite live data. Operator archives the old directory first.
  await mkdir(dataDir,{recursive:false,mode:0o700});
  for(const item of await readdir(source))if(item!=='backup.json')await cp(join(source,item),join(dataDir,item),{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true});
}
