import {bindScope,scopeResponder} from './helpers/scope.mjs';
import {mappingPath, workspacePath} from '../dist/sync/metadata.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {anchorPass,relinkPass,mappingPass,runPull} from '../dist/sync/pull.js';
import {buildTreeRenderer} from '../dist/sync/render.js';
import {docHash} from '../dist/documents/markdown.js';
import {loadMapping} from '../dist/sync/mapping.js';
import {workspace,mockFetch,configure} from './helpers/fixtures.mjs';

test('pull rewrites received page anchors and relative links but retains unreceived URLs',t=>{
 const {root,put}=workspace(t);const a=put('a.md','---\ntitle: A\n---\n[Go](https://example.invalid/wiki/spaces/TEST/pages/2/B#BSection)\n[Remote](https://example.invalid/wiki/spaces/TEST/pages/999/Missing)');
 const b=put('nested/b.md','---\ntitle: B\n---\n## Section\n\n[Self](#BSection)');const paths=new Map([['1',a],['2',b]]);
 const pass=anchorPass([a,b],paths);assert.equal(pass.count,2);assert.equal(relinkPass([a,b],paths,false,pass.info),1);
 assert.match(readFileSync(a,'utf8'),/\[Go\]\(nested\/b.md#section\)/);assert.match(readFileSync(a,'utf8'),/pages\/999\/Missing/);assert.match(readFileSync(b,'utf8'),/\[Self\]\(#section\)/);
});

test('pull to Obsidian uses heading text in page and self wikilinks',t=>{
 const {put}=workspace(t);const a=put('a.md','[B](https://example.invalid/wiki/spaces/TEST/pages/2/B#BSection)');const b=put('b.md','---\ntitle: B\n---\n## Section\n\n[Self](#BSection)');const paths=new Map([['1',a],['2',b]]);
 const {info}=anchorPass([a,b],paths);relinkPass([a,b],paths,true,info);
 assert.match(readFileSync(a,'utf8'),/\[\[b#Section\|B\]\]/);assert.match(readFileSync(b,'utf8'),/\[\[#Section\|Self\]\]/);
});

test('pull mapping uses push hashes, removes moved aliases and preserves unrelated pages',async t=>{
 const {root,put}=workspace(t,{'new.md':'---\ntitle: New\npageId: 1\n---\n## Section\n','folder/child.md':'# Child','.confluence-sync.json':JSON.stringify({'old.md':{pageId:'1'},'untouched.md':{pageId:'9'}})});
 const mapping=mappingPath(root);assert.equal(await mappingPass(root,mapping,new Map([['1',join(root,'new.md')]]),new Map([[join(root,'folder'),'2']])),2);
 const m=loadMapping(mapping);assert.equal(m['old.md'],undefined);assert.equal(m['untouched.md'].pageId,'9');assert.equal(m['folder/'].type,'folder');
 const tree=buildTreeRenderer(root,['new.md','folder/child.md']),d=tree.docs['new.md'];assert.equal(m['new.md'].hash,docHash(d.title,tree.render('new.md',d.body,d.title)));
});

test('full pull downloads referenced image and writes frontmatter plus matching mapping',async t=>{
 const {root,put}=workspace(t);configure(t);bindScope(root);put('.csync/mapping.json',JSON.stringify({'Proposal.md':{pageId:'123'}}));
 const steps=[{path:'/wiki/rest/api/content/123?expand=body.export_view,body.storage,version',body:{id:'123',title:'Proposal',type:'page',body:{export_view:{value:'<h2>Section</h2><p>Text</p><img src="/download/attachments/123/screen.png"/>'},storage:{value:''}},_links:{base:'https://example.invalid',webui:'/wiki/pages/123'},version:{when:'2026-01-01'}}},{path:'/wiki/rest/api/content/123/child/folder?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/123/child/page?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/123/child/attachment?limit=100',body:{results:[{title:'screen.png',_links:{download:'/download/screen.png'}},{title:'unused.pdf',_links:{download:'/download/unused.pdf'}}]}},{path:'/wiki/download/screen.png',bytes:new Uint8Array([1,2,3])}];mockFetch(t,steps,scopeResponder(root,steps));
 await runPull(['pull','123','--out',root]);const path=join(root,'Proposal.md');
 assert.match(readFileSync(path,'utf8'),/pageId: 123/);assert.match(readFileSync(path,'utf8'),/attachments\/Proposal\/screen.png/);assert.deepEqual(readFileSync(join(root,'attachments/Proposal/screen.png')),Buffer.from([1,2,3]));
 assert.equal(existsSync(join(root,'attachments/Proposal/unused.pdf')),false);assert.equal(loadMapping(mappingPath(root))['Proposal.md'].pageId,'123');
});

for (const subtarget of [false,true]) test(`pull ${subtarget ? 'mapped subtarget' : 'scope root'} includes children by default`,async t=>{
 const {root,put}=workspace(t);configure(t);
 if (subtarget) { bindScope(root); put('.csync/mapping.json',JSON.stringify({'Parent/README.md':{pageId:'1'}})); }
 else bindScope(root,{connection:{homepageId:'1'},scope:{id:'1',type:'page'}});
 const steps=[{path:'/wiki/rest/api/content/1?expand=body.export_view,body.storage,version',body:{id:'1',type:'page',title:'Parent',body:{export_view:{value:'<a href="https://example.invalid/wiki/spaces/TEST/pages/2/Child">Child</a>'}}}},{path:'/wiki/rest/api/content/1/child/folder?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/1/child/page?limit=100',body:{results:[{id:'2',title:'Child'}]}},{path:'/wiki/rest/api/content/2?expand=body.export_view,body.storage,version',body:{id:'2',type:'page',title:'Child',body:{export_view:{value:'<p>Hello</p>'}}}},{path:'/wiki/rest/api/content/2/child/folder?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/2/child/page?limit=100',body:{results:[]}}];mockFetch(t,steps,scopeResponder(root,steps));
 await runPull(['pull','1','--out',root]);const dest=subtarget ? join(root,'Parent') : root;assert.ok(existsSync(join(dest,'README.md')));assert.ok(existsSync(join(dest,'Child.md')));assert.match(readFileSync(join(dest,'README.md'),'utf8'),/\[Child\]\(Child.md\)/);assert.equal(existsSync(mappingPath(root)),true);
});

test('whole-space pull starts from homepage and recursively materializes folder nodes',async t=>{
 const {root}=workspace(t);configure(t);bindScope(root);
 const logs=[];t.mock.method(console,'log',line=>logs.push(line));
 const steps=[{path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space',homepageId:'home'}]}},{path:'/wiki/rest/api/content/home?expand=body.export_view,body.storage,version',body:{id:'home',type:'folder',title:'Root'}},{path:'/wiki/rest/api/content/home/child/folder?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/home/child/page?limit=100',body:{results:[{id:'2',title:'Child'}]}},{path:'/wiki/rest/api/content/2?expand=body.export_view,body.storage,version',body:{id:'2',type:'page',title:'Child',body:{export_view:{value:'<p>Body</p>'}}}},{path:'/wiki/rest/api/content/2/child/folder?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/2/child/page?limit=100',body:{results:[]}}];mockFetch(t,steps,scopeResponder(root,steps));
 await runPull(['pull','--space','--out',root]);assert.ok(existsSync(join(root,'Child.md')));assert.equal(existsSync(join(root,'Root')),false);assert.equal(JSON.parse(readFileSync(workspacePath(root),'utf8')).remoteRoot.id,'home');
 const output=logs.join('\n');assert.doesNotMatch(output,/csync-pull-/);assert.match(output,/폴더 준비/);assert.match(output,/다운로드 준비/);assert.ok(output.includes(join(root,'Child.md')));assert.ok(output.includes(root));assert.match(output,/검증 후 저장/);
});

for (const missing of [false,true]) test(`root pull ignores the Confluence spinner and ${missing?'preserves a missing attachment reference and continues':'continues to children and actual attachments'}`,async t=>{
 const {root}=workspace(t);configure(t);bindScope(root,{connection:{homepageId:'1'},scope:{id:'1',type:'page'}});
 const steps=[
 {path:'/wiki/rest/api/content/1?expand=body.export_view,body.storage,version',body:{id:'1',type:'page',title:'Home',version:{number:1},body:{export_view:{value:'<p>Home body</p><img class="waiting-image" alt="잠시 기다려주십시오." src="/wiki/s/hash/_/images/icons/wait.gif">'}}}},
 {path:'/wiki/rest/api/content/1/child/folder?limit=100',body:{results:[]}},
 {path:'/wiki/rest/api/content/1/child/page?limit=100',body:{results:[{id:'2',title:'Child'}]}},
 {path:'/wiki/rest/api/content/2?expand=body.export_view,body.storage,version',body:{id:'2',type:'page',title:'Child',version:{number:1},body:{export_view:{value:'<p>Child body</p><img src="/download/attachments/2/screen.png">'}}}},
 {path:'/wiki/rest/api/content/2/child/folder?limit=100',body:{results:[]}},
 {path:'/wiki/rest/api/content/2/child/page?limit=100',body:{results:[]}},
 {path:'/wiki/rest/api/content/2/child/attachment?limit=100',body:{results:missing?[]:[{title:'screen.png',_links:{download:'/download/screen.png'}}]}},
 ...missing?[]:[{path:'/wiki/download/screen.png',bytes:new Uint8Array([1,2,3])}],
 ];mockFetch(t,steps,scopeResponder(root,steps));
 if(missing){await runPull(['pull','--space','--out',root]);assert.ok(existsSync(join(root,'README.md')));assert.match(readFileSync(join(root,'Child.md'),'utf8'),/https:\/\/example.invalid\/wiki\/download\/attachments\/2\/screen.png/);assert.equal(existsSync(join(root,'attachments/Child/screen.png')),false);assert.ok(loadMapping(mappingPath(root))['Child.md']);}
 else {await runPull(['pull','--space','--out',root]);assert.match(readFileSync(join(root,'README.md'),'utf8'),/Home body/);assert.doesNotMatch(readFileSync(join(root,'README.md'),'utf8'),/wait.gif/);assert.match(readFileSync(join(root,'Child.md'),'utf8'),/attachments\/Child\/screen.png/);assert.deepEqual(readFileSync(join(root,'attachments/Child/screen.png')),Buffer.from([1,2,3]));}
});

for (const status of [404,403,500]) test(`attachment download ${status}: only 404 permits a warning completion`,async t=>{
 const {root}=workspace(t);configure(t);bindScope(root,{connection:{homepageId:'1'},scope:{id:'1',type:'page'}});
 const logs=[];t.mock.method(console,'log',text=>logs.push(text));
 const steps=[
 {path:'/wiki/rest/api/content/1?expand=body.export_view,body.storage,version',body:{id:'1',type:'page',title:'Home',version:{number:1},body:{export_view:{value:'<img src="/wiki/download/attachments/1/missing.png?version=2"><img src="/download/attachments/1/ok.png">'}}}},
 {path:'/wiki/rest/api/content/1/child/folder?limit=100',body:{results:[]}},
 {path:'/wiki/rest/api/content/1/child/page?limit=100',body:{results:[]}},
 {path:'/wiki/rest/api/content/1/child/attachment?limit=100',body:{results:[{title:'missing.png',_links:{download:'/download/missing.png'}},{title:'ok.png',_links:{download:'/download/ok.png'}}]}},
 {path:'/wiki/download/missing.png',status},
 ...status===404?[{path:'/wiki/download/ok.png',bytes:new Uint8Array([1,2,3])}]:[],
 ];mockFetch(t,steps,scopeResponder(root,steps));
 if(status===404){await runPull(['pull','--space','--out',root]);const md=readFileSync(join(root,'README.md'),'utf8');assert.match(md,/https:\/\/example.invalid\/wiki\/download\/attachments\/1\/missing.png\?version=2/);assert.match(md,/attachments\/README\/ok.png/);assert.equal(existsSync(join(root,'attachments/README/missing.png')),false);assert.ok(existsSync(join(root,'attachments/README/ok.png')));assert.match(logs.join('\n'),/\[경고 요약\] 원격 첨부 1개/);}
 else {await assert.rejects(runPull(['pull','--space','--out',root]),new RegExp('download '+status));assert.equal(existsSync(join(root,'README.md')),false);assert.equal(existsSync(mappingPath(root)),false);}
});
