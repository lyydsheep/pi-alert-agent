import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {parseReport,loadReport,reportSummary,reportUrl} from '../src/report.ts';
import type {Task} from '../src/engine.ts';

test('versioned reports unwrap persisted plans and reject stale translations',()=>{
  const body=JSON.stringify({diagnosis:'原始诊断',evidence:['证据']});
  assert.deepEqual(parseReport(JSON.stringify({body})),{diagnosis:'原始诊断',evidence:['证据']});
  assert.equal(parseReport('plain text').summary,'plain text');
  const task={id:1,planVersion:2,plan:{body}} as Task;
  assert.equal(reportUrl(task,'https://alerts.test/'),'https://alerts.test/tasks/1?version=2');
  assert.ok(Array.from(reportSummary({diagnosis:'中'.repeat(1000)})).length<=181);
  const root=mkdtempSync(join(tmpdir(),'report-'));
  try{
    mkdirSync(join(root,'reports'));
    const path=join(root,'reports','1-2.json');
    writeFileSync(path,JSON.stringify({sourceBodyHash:'wrong',report:{diagnosis:'过期译文'}}));
    assert.equal(loadReport(task,root).diagnosis,'原始诊断');
    writeFileSync(path,JSON.stringify({sourceBodyHash:createHash('sha256').update(body).digest('hex'),report:{diagnosis:'中文译文'}}));
    assert.equal(loadReport(task,root).diagnosis,'中文译文');
    assert.equal(task.plan?.body,body);
  }finally{rmSync(root,{recursive:true,force:true});}
});
