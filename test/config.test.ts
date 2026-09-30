import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config.ts';

test('configuration allows missing Owners for safe needs_owner routing and rejects malformed groups',()=>{
  const root=mkdtempSync(join(tmpdir(),'alert-config-'));const path=join(root,'config.json');
  const config={dataDir:root,repositoryPath:root,bot:{id:'test',secret:'test'},model:{id:'test',provider:'test',apiKey:'test'},delivery:{apiEndpoint:'https://example.invalid',token:'test',project:'test',agentReviewCheck:'review',requiredChecks:['tests']},groups:{test:{owners:['owner'],webhook:'https://example.invalid'}}};
  try{
    writeFileSync(path,JSON.stringify(config));assert.equal(loadConfig(path).concurrency,4);
    for(const dashboardUrl of ['javascript:alert(1)','https://user:secret@alerts.test','https://alerts.test/?token=bad']){writeFileSync(path,JSON.stringify({...config,dashboardUrl}));assert.throws(()=>loadConfig(path));}
    writeFileSync(path,JSON.stringify({...config,dashboardUrl:'https://alerts.test/'}));assert.equal(loadConfig(path).dashboardUrl,'https://alerts.test/');
    writeFileSync(path,JSON.stringify({...config,groups:{test:{owners:[],webhook:'https://example.invalid'}}}));assert.deepEqual(loadConfig(path).groups.test.owners,[]);
    for(const groups of [{},[],{test:null},{test:{owners:[' '],webhook:'https://example.invalid'}}]){
      writeFileSync(path,JSON.stringify({...config,groups}));assert.throws(()=>loadConfig(path),/configuration/);
    }
    writeFileSync(path,JSON.stringify({...config,delivery:{command:process.execPath,args:['bridge.mjs'],project:'project',agentReviewCheck:'review',requiredChecks:['tests']}}));
    assert.equal('command' in loadConfig(path).delivery,true);
    for(const delivery of [
      {command:process.execPath,project:'project',agentReviewCheck:'review',requiredChecks:[]},
      {command:process.execPath,args:[1],project:'project',agentReviewCheck:'review',requiredChecks:['tests']},
      {command:process.execPath,project:'',agentReviewCheck:'review',requiredChecks:['tests']},
      {command:null,apiEndpoint:'https://example.invalid',token:'test',project:'project',agentReviewCheck:'review',requiredChecks:['tests']},
      {command:process.execPath,project:'project',agentReviewCheck:'review',requiredChecks:[' ']},
    ]){writeFileSync(path,JSON.stringify({...config,delivery}));assert.throws(()=>loadConfig(path),/delivery/);}
  }finally{rmSync(root,{recursive:true,force:true});}
});
