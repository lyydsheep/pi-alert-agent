import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard, dashboard } from '../src/web.ts';
import type { Task } from '../src/engine.ts';

test('dashboard escapes task content and exposes no write endpoints', async () => {
  const task = {id:1,source:'<script>x</script>',eventId:'e',status:'queued',ownerIds:[],planVersion:0,updatedAt:0} as unknown as Task;
  assert(!dashboard([task]).includes('<script>'));
  const server=createDashboard(()=>[task]);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  try {
    const base=`http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(base+'/api/tasks')).status,200);
    assert.equal((await fetch(base+'/api/tasks',{method:'POST'})).status,405);
    assert.equal((await fetch(base+'/admin')).status,404);
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});
