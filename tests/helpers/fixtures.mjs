import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
export function workspace(t,files={}) {
 const root=mkdtempSync(join(tmpdir(),'csync-tests-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(rel,content)=>{const path=join(root,rel);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content);return path;};
 for(const [rel,content] of Object.entries(files))put(rel,content);
 return {root,put};
}
// Unexpected calls fail instead of reaching any network. All credentials below are synthetic.
export function mockFetch(t,steps) {
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,init={})=>{
  const step=steps[calls.length];calls.push({url:String(url),...init});
  assert.ok(step,`Unexpected request: ${url}`);
  assert.equal(new URL(url).pathname+new URL(url).search,step.path);
  assert.equal(init.method??'GET',step.method??'GET');
  step.check?.(init);
  return new Response(step.status===204?null:step.bytes??JSON.stringify(step.body??{}),{status:step.status??200});
 });
 t.after(()=>assert.equal(calls.length,steps.length,'Every expected request occurred'));
 return calls;
}
export function configure(t) {
 for(const [name,value] of Object.entries({CONFLUENCE_BASE_URL:'https://example.invalid/wiki',CONFLUENCE_EMAIL:'test@example.invalid',CONFLUENCE_API_TOKEN:'test-token',CONFLUENCE_SPACE_KEY:'TEST'})) {
  const old=process.env[name];process.env[name]=value;
  t.after(()=>{if(old===undefined)delete process.env[name];else process.env[name]=old;});
 }
}
