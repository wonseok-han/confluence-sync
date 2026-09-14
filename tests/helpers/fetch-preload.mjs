// Used only by CLI integration tests. No request can leave the test process.
import {readFileSync,appendFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const steps=JSON.parse(readFileSync(process.env.CSYNC_TEST_RESPONSES,'utf8'));
let index=0;
globalThis.fetch=async(url,init={})=>{
 const step=steps[index++];assert.ok(step,`Unexpected request ${url}`);
 const path=new URL(url).pathname+new URL(url).search;
 assert.equal(path,step.path);assert.equal(init.method??'GET',step.method??'GET');
 appendFileSync(process.env.CSYNC_TEST_CALLS,JSON.stringify({path,method:init.method??'GET',body:typeof init.body==='string'?JSON.parse(init.body):null})+'\n');
 return new Response(step.status===204?null:JSON.stringify(step.body??{}),{status:step.status??200});
};
process.on('exit',()=>{if(index!==steps.length)process.exitCode=1;});
