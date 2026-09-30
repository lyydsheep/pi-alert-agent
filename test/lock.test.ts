import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireServiceLock} from '../src/lock.ts';

test('only one concurrent starter acquires the service lock',async()=>{
  const root=await mkdtemp(join(tmpdir(),'alert-lock-'));
  try {
    const results=await Promise.allSettled([acquireServiceLock(root),acquireServiceLock(root)]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    for(const result of results)if(result.status==='fulfilled')await result.value();
    const release=await acquireServiceLock(root);await release();
  }finally{await rm(root,{recursive:true,force:true});}
});
