import test from 'node:test';
import assert from 'node:assert/strict';
import register from '../src/pi/extension.ts';
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
