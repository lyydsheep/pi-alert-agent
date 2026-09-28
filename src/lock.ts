import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function acquireServiceLock(dataDir:string):Promise<()=>Promise<void>> {
  await mkdir(dataDir,{recursive:true});
  const lock=join(dataDir,'service.lock');
  const claim=join(dataDir,'startup.lock');
  // Fail closed if a process crashes during takeover; operator inspects this tiny window.
  await mkdir(claim);
  try {
    try {
      await mkdir(lock);
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const pid=Number(await readFile(join(lock,'pid'),'utf8').catch(()=>''));
      if(!Number.isSafeInteger(pid)||pid<1)throw new Error('Incomplete service lock: inspect before restarting');
      try {process.kill(pid,0);throw new Error('Another service process is active');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
      // Old supervisors receive IPC disconnect and have a bounded 5s kill grace.
      await new Promise(resolve=>setTimeout(resolve,6000));
      await rm(lock,{recursive:true});await mkdir(lock);
    }
    await writeFile(join(lock,'pid'),String(process.pid));
  } finally {await rm(claim,{recursive:true});}
  return async()=>{await rm(lock,{recursive:true});};
}
