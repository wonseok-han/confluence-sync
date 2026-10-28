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
const batch=(versions={},omit=[])=>({path:'/wiki/api/v2/pages?space-id=space&status=current&limit=100',body:{results:[['100','Home'],['101','A'],['102','B'],['103','C'],['104','D']].filter(([id])=>!omit.includes(id)).map(([id,title])=>({id,title,spaceId:'space',parentId:'100',version:{number:versions[id]??1}}))}});
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

test('default Pull skips both-sided edits and applies clean remote changes independently',async t=>{
 const {root,put,mapping}=await fixture(t);put('a.md','# My local edits');
 scopedMock(t,root,[batch({'101':2,'102':2}),node('102','B','<p>B changed</p>')]);
 await runPull(['pull','--base',root]);const after=JSON.parse(readFileSync(mappingPath(root),'utf8'));
 assert.equal(readFileSync(join(root,'a.md'),'utf8'),'# My local edits');assert.deepEqual(after['a.md'],mapping['a.md']);assert.match(readFileSync(join(root,'b.md'),'utf8'),/B changed/);assert.equal(after['b.md'].remoteVersion,2);
});

test('default Pull preserves a local deletion even when its remote version is unchanged',async t=>{
 const {root}=await fixture(t);scopedMock(t,root,[batch()]);rmSync(join(root,'c.md'));const before=readFileSync(mappingPath(root),'utf8');
 await runPull(['pull','--base',root]);assert.equal(existsSync(join(root,'c.md')),false);assert.equal(readFileSync(mappingPath(root),'utf8'),before);
});

test('Fetch omissions preserve those documents while safe incoming edits still download',async t=>{
 const {root}=await fixture(t);const steps=[batch({'101':2},['103']),node('101','A','<p>New safe edit</p>')];scopedMock(t,root,steps);await fetchRemote(root,env);const mapping=readFileSync(mappingPath(root),'utf8'),a=readFileSync(join(root,'a.md'),'utf8');
 await runPull(['pull','--base',root]);assert.match(readFileSync(join(root,'a.md'),'utf8'),/New safe edit/);assert.ok(existsSync(join(root,'c.md')));assert.deepEqual(JSON.parse(readFileSync(mappingPath(root),'utf8'))['c.md'],JSON.parse(mapping)['c.md']);
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

test('retired file scope does not filter Fetch and changed pages link to unchanged workspace pages',async t=>{
 const {root,put,mapping}=await fixture(t);const config=JSON.parse(readFileSync(workspacePath(root),'utf8'));config.scope={path:'a.md',type:'file'};put('.csync/workspace.json',JSON.stringify(config));
 const steps=[batch({'101':2}),node('101','A','<p><a href="https://example.invalid/wiki/spaces/TEST/pages/103/C#CSection">C</a></p>',2)];scopedMock(t,root,steps);await fetchRemote(root,env);
 await runPull(['pull','--base',root,'--obsidian']);assert.match(readFileSync(join(root,'a.md'),'utf8'),/\[\[c#Section\|C\]\]/);assert.deepEqual(JSON.parse(readFileSync(mappingPath(root),'utf8'))['c.md'],mapping['c.md']);
});

test('scope changes during a Fetch refresh abort before any body download',async t=>{
 const {root,put}=await fixture(t);let now=Date.now();t.mock.method(Date,'now',()=>now);
 const refreshed=batch({'101':2});refreshed.check=()=>{const config=JSON.parse(readFileSync(workspacePath(root),'utf8'));config.scope={path:'a.md',type:'file'};put('.csync/workspace.json',JSON.stringify(config))};
 scopedMock(t,root,[batch(),refreshed]);await fetchRemote(root,env);now+=FETCH_TTL_MS+1;const mapping=readFileSync(mappingPath(root),'utf8');
 await assert.rejects(runPull(['pull','--base',root]),/설정·매핑이 변경/);assert.equal(readFileSync(mappingPath(root),'utf8'),mapping);assert.equal(JSON.parse(readFileSync(workspacePath(root),'utf8')).scope.path,'a.md');
});

test('legacy raw-rendered baseline accepts untouched documents despite automatic preprocessing changes',async t=>{
 const {root,put}=await fixture(t);const {buildTreeRenderer}=await import('../dist/sync/render.js');const {docHash}=await import('../dist/documents/markdown.js');const {writeFileSync}=await import('node:fs');
 put('a.md','---\ntitle: A\npageId: 101\n---\nEvidence[^n].\n\n[^n]: Original note\n');
 const tree=buildTreeRenderer(root,['README.md','a.md','b.md','c.md','d.md']);const doc=tree.docs['a.md'];const mapping=JSON.parse(readFileSync(mappingPath(root),'utf8'));
 mapping['a.md'].hash=docHash(doc.title,tree.render('a.md',doc.body,doc.title));delete mapping['a.md'].localHash;writeFileSync(mappingPath(root),JSON.stringify(mapping));
 scopedMock(t,root,[batch({'101':2}),node('101','A','<p>Remote update</p>')]);await fetchRemote(root,env);await runPull(['pull','--base',root]);
 assert.match(readFileSync(join(root,'a.md'),'utf8'),/Remote update/);assert.match(JSON.parse(readFileSync(mappingPath(root),'utf8'))['a.md'].localHash,/^[a-f0-9]{64}$/);
});

test('new incoming anchor links do not mark an untouched target document as locally edited',async t=>{
 const {root,put}=await fixture(t);put('a.md','---\ntitle: A\npageId: 101\n---\n## Section\n\nOriginal');
 await mappingPass(root,mappingPath(root),new Map([['101',join(root,'a.md')]]),new Map(),new Map([['101',1]]));
 put('b.md','---\ntitle: B\npageId: 102\n---\n[New incoming link](a.md#section)');
 scopedMock(t,root,[batch({'101':2}),node('101','A','<h2>Section</h2><p>Updated remote</p>')]);await fetchRemote(root,env);await runPull(['pull','--base',root]);
 assert.match(readFileSync(join(root,'a.md'),'utf8'),/Updated remote/);assert.match(readFileSync(join(root,'b.md'),'utf8'),/New incoming link/);
});

for(const attachment of [false,true])test(`new local baseline still protects real ${attachment?'attachment':'whitespace'} edits`,async t=>{
 const {root,put}=await fixture(t);put('a.md',attachment?'---\ntitle: A\npageId: 101\n---\n![](image.png)':'---\ntitle: A\npageId: 101\n---\nA original');if(attachment)put('image.png','original');
 await mappingPass(root,mappingPath(root),new Map([['101',join(root,'a.md')]]),new Map(),new Map([['101',1]]));
 if(attachment)put('image.png','changed');else put('a.md',readFileSync(join(root,'a.md'),'utf8')+'\n\n');
 scopedMock(t,root,[batch({'101':2})]);await fetchRemote(root,env);
 const before=readFileSync(mappingPath(root),'utf8');await runPull(['pull','--base',root]);assert.equal(readFileSync(mappingPath(root),'utf8'),before);
});

for(const edited of [false,true])test(`Pull handles a pre-callout baseline without losing real edits: edited=${edited}`,async t=>{
 const {root,put}=await fixture(t);const {hashOf}=await import('../dist/documents/markdown.js');const {writeFileSync}=await import('node:fs');
 put('a.md','---\ntitle: A\npageId: 101\n---\n> [!summary]\n> Original');
 const mapping=JSON.parse(readFileSync(mappingPath(root),'utf8'));delete mapping['a.md'].localHash;
 mapping['a.md'].hash=hashOf('A\0<blockquote>\n<p>[!summary]\nOriginal</p>\n</blockquote>\n');writeFileSync(mappingPath(root),JSON.stringify(mapping));
 if(edited)put('a.md','---\ntitle: A\npageId: 101\n---\n> [!summary]\n> My edits');
 scopedMock(t,root,[batch({'101':2}),...(!edited?[node('101','A','<p>Remote update</p>')]:[])]);await fetchRemote(root,env);
 if(edited){await runPull(['pull','--base',root]);assert.match(readFileSync(join(root,'a.md'),'utf8'),/My edits/)}
 else{await runPull(['pull','--base',root]);assert.match(readFileSync(join(root,'a.md'),'utf8'),/Remote update/)}
});

test('remote-only Pull downloads clean remote edits while preserving both-sided edits and their baselines',async t=>{
 const {root,put}=await fixture(t);put('a.md','# My local work');const before=JSON.parse(readFileSync(mappingPath(root),'utf8'));
 const calls=scopedMock(t,root,[batch({'101':2,'102':2}),node('102','B','<p>New remote B</p>')]);
 await runPull(['pull','--base',root,'--remote-only']);assert.equal(readFileSync(join(root,'a.md'),'utf8'),'# My local work');assert.match(readFileSync(join(root,'b.md'),'utf8'),/New remote B/);
 const after=JSON.parse(readFileSync(mappingPath(root),'utf8'));assert.deepEqual(after['a.md'],before['a.md']);assert.equal(after['b.md'].remoteVersion,2);assert.deepEqual(after['c.md'],before['c.md']);assert.equal(calls.filter(call=>call.url.includes('body.export_view')).length,1);assert.ok(calls.every(call=>!call.url.includes('/child/')));
});

test('remote-only Pull never falls back to a full tree when all changed targets have local edits',async t=>{
 const {root,put}=await fixture(t);put('a.md','# Keep local');const before=readFileSync(mappingPath(root),'utf8');scopedMock(t,root,[batch({'101':2})]);
 await runPull(['pull','--base',root,'--remote-only']);assert.equal(readFileSync(mappingPath(root),'utf8'),before);assert.equal(readFileSync(join(root,'a.md'),'utf8'),'# Keep local');
 await assert.rejects(runPull(['pull','--base',root,'--remote-only','--full']),/함께 사용할 수 없습니다/);
});

test('display observations retain remaining remote conflicts after a clean remote-only Pull',async t=>{
 const {root,put}=await fixture(t);const {readFetchSnapshot}=await import('../dist/sync/fetch.js');put('a.md','# Keep local');
 scopedMock(t,root,[batch({'101':2,'102':2}),node('102','B','<p>New remote B</p>')]);await runPull(['pull','--base',root,'--remote-only']);
 const observation=readFetchSnapshot(root,env);assert.ok(observation);assert.equal(observation.items.find(i=>i.pageId==='101').state,'changed');assert.equal(observation.items.find(i=>i.pageId==='102').state,'unchanged');assert.equal(observation.items.find(i=>i.pageId==='102').baselineVersion,2);
});

test('Pull acknowledges a remote move without renaming local files or repeatedly reporting that move',async t=>{
 const {root,mapping}=await fixture(t);const {readFetchSnapshot}=await import('../dist/sync/fetch.js');
 const movedBatch=()=>{const step=batch();step.body.results.find(p=>p.id==='101').parentId='900';return step};
 const location={path:'/wiki/rest/api/content/101?expand=ancestors,space,version',body:{id:'101',title:'A',type:'page',space:{id:'space'},ancestors:[{id:'100',title:'Home'},{id:'900',title:'Archive'}]}};
 const calls=scopedMock(t,root,[movedBatch(),location,node('101','A','<p>A original</p>',1),movedBatch()]);
 await fetchRemote(root,env);assert.equal(readFetchSnapshot(root,env).items.find(i=>i.pageId==='101').state,'changed');
 await runPull(['pull','--base',root]);const after=JSON.parse(readFileSync(mappingPath(root),'utf8'));
 assert.equal(after['a.md'].remoteParentId,'900');assert.equal(after['a.md'].remoteVersion,1);assert.deepEqual(after['b.md'],mapping['b.md']);assert.ok(existsSync(join(root,'a.md')));
 assert.equal(readFetchSnapshot(root,env).items.find(i=>i.pageId==='101').state,'unchanged');
 const before=readFileSync(mappingPath(root),'utf8');await runPull(['pull','--base',root]);assert.equal(readFileSync(mappingPath(root),'utf8'),before);
 assert.equal(calls.filter(call=>call.url.includes('body.export_view')).length,1);
});

test('failed moved-page download never acknowledges its remote parent or content baseline',async t=>{
 const {root}=await fixture(t);const step=batch();step.body.results.find(p=>p.id==='101').parentId='900';const before=readFileSync(mappingPath(root),'utf8');
 const location={path:'/wiki/rest/api/content/101?expand=ancestors,space,version',body:{id:'101',type:'page',space:{id:'space'},ancestors:[{id:'100'},{id:'900'}]}};
 scopedMock(t,root,[step,location,{...node('101','A','<p>A original</p>',1),status:403}]);await assert.rejects(runPull(['pull','--base',root]),/403/);assert.equal(readFileSync(mappingPath(root),'utf8'),before);
});
