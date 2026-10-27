import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,statSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {workspace,mockFetch,configure} from './helpers/fixtures.mjs';
import {bindScope,scopeResponder} from './helpers/scope.mjs';
import {mappingPath,workspacePath} from '../dist/sync/metadata.js';
import {mappingPass,runPull} from '../dist/sync/pull.js';
import {fetchRemote,FETCH_TTL_MS} from '../dist/sync/fetch.js';
const env={baseUrl:'https://example.invalid/wiki',email:'test@example.invalid',token:'test-token',spaceKey:'TEST'};
const node=(id,title,html,version=2)=>({path:`/wiki/rest/api/content/${id}?expand=body.export_view,body.storage,version`,body:{id:String(id),type:'page',title,body:{export_view:{value:html},storage:{value:html}},version:{number:version}}});
const batch=(versions={},omit=[])=>({path:'/wiki/api/v2/pages?space-id=space&status=current&limit=100&id=101%2C102%2C103%2C104%2C100',body:{results:[['100','Home'],['101','A'],['102','B'],['103','C'],['104','D']].filter(([id])=>!omit.includes(id)).map(([id,title])=>({id,title,spaceId:'space',parentId:'100',version:{number:versions[id]??1}}))}});
async function fixture(t){
 configure(t);const {root,put}=workspace(t,{'README.md':'---\ntitle: Home\npageId: 100\n---\nHome','a.md':'---\ntitle: A\npageId: 101\n---\nA original','b.md':'---\ntitle: B\npageId: 102\n---\nB original','c.md':'---\ntitle: C\npageId: 103\n---\n## Section\n\nC original','d.md':'---\ntitle: D\npageId: 104\n---\nD original'});
 bindScope(root,{connection:{homepageId:'100'},scope:{id:'100',type:'page',path:'/'}});
 await mappingPass(root,mappingPath(root),new Map([['100',join(root,'README.md')],['101',join(root,'a.md')],['102',join(root,'b.md')],['103',join(root,'c.md')],['104',join(root,'d.md')]]),new Map(),new Map(['100','101','102','103','104'].map(id=>[id,1])));
 return {root,put,mapping:JSON.parse(readFileSync(mappingPath(root),'utf8'))};
}
const scopedMock=(t,root,steps)=>mockFetch(t,steps,scopeResponder(root,steps));

test('root Pull uses Fetch to download exactly two changed bodies, skips all child scans, and keeps unchanged files and links',async t=>{
 const {root,mapping}=await fixture(t);const c=readFileSync(join(root,'c.md'),'utf8'),mtime=statSync(join(root,'c.md')).mtimeMs;
 const steps=[batch({'101':2,'102':2}),node('101','A','<p>A changed <a href="https://example.invalid/wiki/spaces/TEST/pages/103/C#CSection">C section</a></p>'),node('102','B','<p>B changed</p>'),batch({'101':2,'102':2})];
 const calls=scopedMock(t,root,steps);await fetchRemote(root,env);await runPull(['pull','--base',root]);
 assert.equal(calls.filter(call=>call.url.includes('body.export_view')).length,2);assert.ok(calls.every(call=>!call.url.includes('/child/')));
 assert.match(readFileSync(join(root,'a.md'),'utf8'),/\[C section\]\(c.md#section\)/);assert.match(readFileSync(join(root,'b.md'),'utf8'),/B changed/);
 assert.equal(readFileSync(join(root,'c.md'),'utf8'),c);assert.equal(statSync(join(root,'c.md')).mtimeMs,mtime);
 const after=JSON.parse(readFileSync(mappingPath(root),'utf8'));for(const path of ['README.md','c.md','d.md'])assert.deepEqual(after[path],mapping[path]);assert.equal(after['a.md'].remoteVersion,2);assert.equal(after['b.md'].remoteVersion,2);
 const baseline=readFileSync(mappingPath(root),'utf8'),stamp=statSync(mappingPath(root)).mtimeMs;
 await runPull(['pull','--base',root]); // changed baseline invalidates the old cache; one batch finds no further changes
 assert.equal(calls.filter(call=>call.url.includes('body.export_view')).length,2);assert.equal(readFileSync(mappingPath(root),'utf8'),baseline);assert.equal(statSync(mappingPath(root)).mtimeMs,stamp);
});

test('unchanged cached Pull performs no remote requests, preserves dirty local files, and never advances their baselines',async t=>{
 const {root,put}=await fixture(t);const steps=[batch()];scopedMock(t,root,steps);await fetchRemote(root,env);put('c.md','# My local edits');const before=readFileSync(mappingPath(root),'utf8');
 await runPull(['pull','--base',root]);assert.equal(readFileSync(join(root,'c.md'),'utf8'),'# My local edits');assert.equal(readFileSync(mappingPath(root),'utf8'),before);
});

test('local changes in a changed remote document abort all staged writes',async t=>{
 const {root,put}=await fixture(t);const steps=[batch({'101':2,'102':2}),node('101','A','<p>A changed</p>'),node('102','B','<p>B changed</p>')];scopedMock(t,root,steps);await fetchRemote(root,env);put('a.md','# My local edits');const before=readFileSync(mappingPath(root),'utf8'),b=readFileSync(join(root,'b.md'),'utf8');
 await assert.rejects(runPull(['pull','--base',root]),/로컬 변경 충돌/);assert.equal(readFileSync(mappingPath(root),'utf8'),before);assert.equal(readFileSync(join(root,'a.md'),'utf8'),'# My local edits');assert.equal(readFileSync(join(root,'b.md'),'utf8'),b);
});

test('a missing local file is restored even if Fetch reports its version unchanged',async t=>{
 const {root}=await fixture(t);const steps=[batch(),node('103','C','<h2>Section</h2><p>C restored</p>',1)];scopedMock(t,root,steps);await fetchRemote(root,env);rmSync(join(root,'c.md'));
 await runPull(['pull','--base',root]);assert.match(readFileSync(join(root,'c.md'),'utf8'),/C restored/);
});

test('Fetch lookup omissions stop Pull without treating pages as deleted or downloading anything',async t=>{
 const {root}=await fixture(t);const steps=[batch({'101':2},['103'])];scopedMock(t,root,steps);await fetchRemote(root,env);const mapping=readFileSync(mappingPath(root),'utf8'),a=readFileSync(join(root,'a.md'),'utf8');
 await assert.rejects(runPull(['pull','--base',root]),/조회 불가/);assert.equal(readFileSync(mappingPath(root),'utf8'),mapping);assert.equal(readFileSync(join(root,'a.md'),'utf8'),a);assert.ok(existsSync(join(root,'c.md')));
});

test('expired Fetch is refreshed in a batch and lookup failure never falls back to expensive full traversal',async t=>{
 const {root}=await fixture(t);let now=Date.now();t.mock.method(Date,'now',()=>now);const steps=[batch(),{...batch(),status:429,body:{message:'Rate limited'}}];scopedMock(t,root,steps);await fetchRemote(root,env);const before=readFileSync(join(root,'.csync/remote.json'),'utf8');now+=FETCH_TTL_MS+1;
 await assert.rejects(runPull(['pull','--base',root]),/429/);assert.equal(readFileSync(join(root,'.csync/remote.json'),'utf8'),before);
});

for(const version of [1,undefined])test(`a body response older than Fetch or missing its version cannot advance the baseline (${version})`,async t=>{
 const {root}=await fixture(t);const body=node('101','A','<p>New</p>',version);if(version===undefined)delete body.body.version;
 const steps=[batch({'101':2}),body];scopedMock(t,root,steps);await fetchRemote(root,env);const before=readFileSync(mappingPath(root),'utf8');
 await assert.rejects(runPull(['pull','--base',root]),/Fetch보다 이전/);assert.equal(readFileSync(mappingPath(root),'utf8'),before);
});

test('Pull accepts a newer body than the Fetch snapshot and uses its actual version',async t=>{
 const {root}=await fixture(t);const steps=[batch({'101':2}),node('101','A','<p>Latest body</p>',3)];scopedMock(t,root,steps);await fetchRemote(root,env);
 await runPull(['pull','--base',root]);assert.equal(JSON.parse(readFileSync(mappingPath(root),'utf8'))['a.md'].remoteVersion,3);
});

test('--full bypasses Fetch and traverses new remote children',async t=>{
 const {root}=await fixture(t);const steps=[batch(),node('100','Home','<p>Home</p>',1),{path:'/wiki/rest/api/content/100/child/folder?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/100/child/page?limit=100',body:{results:[{id:'999',title:'New'}]}},node('999','New','<p>New page</p>',1),{path:'/wiki/rest/api/content/999/child/folder?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/999/child/page?limit=100',body:{results:[]}}];scopedMock(t,root,steps);await fetchRemote(root,env);
 await runPull(['pull','--base',root,'--full']);assert.match(readFileSync(join(root,'New.md'),'utf8'),/New page/);assert.equal(JSON.parse(readFileSync(mappingPath(root),'utf8'))['New.md'].pageId,'999');
});

test('partial file scope uses only its Fetch entry and can link to an unchanged page outside the scope',async t=>{
 const {root,put,mapping}=await fixture(t);const config=JSON.parse(readFileSync(workspacePath(root),'utf8'));config.scope={path:'a.md',type:'file'};put('.csync/workspace.json',JSON.stringify(config));
 const steps=[{path:'/wiki/api/v2/pages?space-id=space&status=current&limit=100&id=101',body:{results:[{id:'101',title:'A',spaceId:'space',parentId:'100',version:{number:2}}]}},node('101','A','<p><a href="https://example.invalid/wiki/spaces/TEST/pages/103/C#CSection">C</a></p>',2)];scopedMock(t,root,steps);await fetchRemote(root,env);
 await runPull(['pull','--base',root,'--obsidian']);assert.match(readFileSync(join(root,'a.md'),'utf8'),/\[\[c#Section\|C\]\]/);assert.deepEqual(JSON.parse(readFileSync(mappingPath(root),'utf8'))['c.md'],mapping['c.md']);
});

test('scope changes during a Fetch refresh abort before any body download',async t=>{
 const {root,put}=await fixture(t);let now=Date.now();t.mock.method(Date,'now',()=>now);
 const refreshed=batch({'101':2});refreshed.check=()=>{const config=JSON.parse(readFileSync(workspacePath(root),'utf8'));config.scope={path:'a.md',type:'file'};put('.csync/workspace.json',JSON.stringify(config))};
 scopedMock(t,root,[batch(),refreshed]);await fetchRemote(root,env);now+=FETCH_TTL_MS+1;const mapping=readFileSync(mappingPath(root),'utf8');
 await assert.rejects(runPull(['pull','--base',root]),/설정·매핑이 변경/);assert.equal(readFileSync(mappingPath(root),'utf8'),mapping);assert.equal(JSON.parse(readFileSync(workspacePath(root),'utf8')).scope.path,'a.md');
});
