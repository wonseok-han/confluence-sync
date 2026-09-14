import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {anchorPass,relinkPass,mappingPass,runPull} from '../dist/pull.js';
import {buildTreeRenderer} from '../dist/render.js';
import {docHash} from '../dist/markdown.js';
import {loadMapping} from '../dist/mapping.js';
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

test('pull mapping uses push hashes, removes moved aliases and preserves unrelated pages',t=>{
 const {root,put}=workspace(t,{'new.md':'---\ntitle: New\npageId: 1\n---\n## Section\n','folder/child.md':'# Child','.confluence-sync.json':JSON.stringify({'old.md':{pageId:'1'},'untouched.md':{pageId:'9'}})});
 const mapping=join(root,'.confluence-sync.json');assert.equal(mappingPass(root,mapping,new Map([['1',join(root,'new.md')]]),new Map([[join(root,'folder'),'2']])),2);
 const m=loadMapping(mapping);assert.equal(m['old.md'],undefined);assert.equal(m['untouched.md'].pageId,'9');assert.equal(m['folder/'].type,'folder');
 const tree=buildTreeRenderer(root,['new.md','folder/child.md']),d=tree.docs['new.md'];assert.equal(m['new.md'].hash,docHash(d.title,tree.render('new.md',d.body,d.title)));
});

test('full pull downloads referenced image and writes frontmatter plus matching mapping',async t=>{
 const {root}=workspace(t);configure(t);
 mockFetch(t,[{path:'/wiki/rest/api/content/123?expand=body.export_view,body.storage,version',body:{id:'123',title:'Proposal',type:'page',body:{export_view:{value:'<h2>Section</h2><p>Text</p><img src="/download/attachments/123/screen.png"/>'},storage:{value:''}},_links:{base:'https://example.invalid',webui:'/wiki/pages/123'},version:{when:'2026-01-01'}}},{path:'/wiki/rest/api/content/123/child/attachment?limit=100',body:{results:[{title:'screen.png',_links:{download:'/download/screen.png'}},{title:'unused.pdf',_links:{download:'/download/unused.pdf'}}]}},{path:'/wiki/download/screen.png',bytes:new Uint8Array([1,2,3])}]);
 await runPull(['pull','123','--out',root]);const path=join(root,'Proposal.md');
 assert.match(readFileSync(path,'utf8'),/pageId: 123/);assert.match(readFileSync(path,'utf8'),/attachments\/Proposal\/screen.png/);assert.deepEqual(readFileSync(join(root,'attachments/Proposal/screen.png')),Buffer.from([1,2,3]));
 assert.equal(existsSync(join(root,'attachments/Proposal/unused.pdf')),false);assert.equal(loadMapping(join(root,'.confluence-sync.json'))['Proposal.md'].pageId,'123');
});

test('pull children creates parent README and local child links; no-mapping is respected',async t=>{
 const {root}=workspace(t);configure(t);
 mockFetch(t,[{path:'/wiki/rest/api/content/1?expand=body.export_view,body.storage,version',body:{id:'1',type:'page',title:'Parent',body:{export_view:{value:'<a href="https://example.invalid/wiki/spaces/TEST/pages/2/Child">Child</a>'}}}},{path:'/wiki/rest/api/content/1/child/folder?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/1/child/page?limit=100',body:{results:[{id:'2',title:'Child'}]}},{path:'/wiki/rest/api/content/2?expand=body.export_view,body.storage,version',body:{id:'2',type:'page',title:'Child',body:{export_view:{value:'<p>Hello</p>'}}}},{path:'/wiki/rest/api/content/2/child/folder?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/2/child/page?limit=100',body:{results:[]}}]);
 await runPull(['pull','1','--children','--no-mapping','--out',root]);assert.ok(existsSync(join(root,'Parent/README.md')));assert.ok(existsSync(join(root,'Parent/Child.md')));assert.match(readFileSync(join(root,'Parent/README.md'),'utf8'),/\[Child\]\(Child.md\)/);assert.equal(existsSync(join(root,'.confluence-sync.json')),false);
});

test('whole-space pull starts from homepage and recursively materializes folder nodes',async t=>{
 const {root}=workspace(t);configure(t);
 mockFetch(t,[{path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space',homepageId:'home'}]}},{path:'/wiki/rest/api/content/home?expand=body.export_view,body.storage,version',body:{id:'home',type:'folder',title:'Root'}},{path:'/wiki/rest/api/content/home/child/folder?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/home/child/page?limit=100',body:{results:[{id:'2',title:'Child'}]}},{path:'/wiki/rest/api/content/2?expand=body.export_view,body.storage,version',body:{id:'2',type:'page',title:'Child',body:{export_view:{value:'<p>Body</p>'}}}},{path:'/wiki/rest/api/content/2/child/folder?limit=100',body:{results:[]}},{path:'/wiki/rest/api/content/2/child/page?limit=100',body:{results:[]}}]);
 await runPull(['pull','--space','--out',root]);assert.ok(existsSync(join(root,'Root/Child.md')));assert.equal(loadMapping(join(root,'.confluence-sync.json'))['Root/'].type,'folder');
});
