import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {runRemap} from '../dist/sync/remap.js';
import {runPush} from '../dist/sync/push.js';
import {workspace,mockFetch,configure} from './helpers/fixtures.mjs';
const fm = (id, title='A') => `---\npageId: ${id}\ntitle: ${title}\n---\n\nBody\n`;
const load = root => JSON.parse(readFileSync(join(root,'.confluence-sync.json'),'utf8'));

test('remap is offline, preserves hash, removes old key, and is repeatable',async t=>{
 mockFetch(t,[]);
 const old={'old/a.md':{pageId:'1',hash:'original',title:'Old'},'old/':{pageId:'folder',type:'folder'}};
 const {root}=workspace(t,{'new/a.md':fm('1'),'.confluence-sync.json':JSON.stringify(old),'notes.md':'notes'});
 await runRemap(['remap','--base',root]);
 const m=load(root);assert.equal(m['old/a.md'],undefined);assert.deepEqual(m['new/a.md'],{...old['old/a.md'],pendingMove:{parentKey:'new/'}});assert.deepEqual(m['old/'],old['old/']);assert.equal(m['notes.md'],undefined);
 await runRemap(['remap','--base',root]);assert.deepEqual(load(root),m);
});

test('separate source mapping stays untouched, dry-run writes nothing, repeat import works',async t=>{
 mockFetch(t,[]);const source=workspace(t,{'.confluence-sync.json':JSON.stringify({'old.md':{pageId:'1',hash:'kept'}})});
 const {root}=workspace(t,{'new.md':fm('1')});const from=join(source.root,'.confluence-sync.json');const before=readFileSync(from,'utf8');
 const args=['remap','--base',root,'--from-mapping',from];
 await runRemap([...args,'--dry-run']);assert.equal(existsSync(join(root,'.confluence-sync.json')),false);
 await runRemap(args);await runRemap(args);assert.equal(load(root)['new.md'].hash,'kept');assert.equal(readFileSync(from,'utf8'),before);
});

for (const kind of ['duplicate','conflict','invalid']) test(`remap rejects ${kind} without replacing mapping`,async t=>{
 mockFetch(t,[]);const original=kind==='invalid'?'broken':JSON.stringify({'a.md':{pageId:'1',hash:'keep'}});
 const {root}=workspace(t,{'.confluence-sync.json':original,'a.md':fm(kind==='conflict'?'2':'1'),...(kind==='duplicate'?{'b.md':fm('1')}:{})});
 await assert.rejects(runRemap(['remap','--base',root]));assert.equal(readFileSync(join(root,'.confluence-sync.json'),'utf8'),original);
});

test('remap honors ignore and README parent identity',async t=>{
 mockFetch(t,[]);const {root}=workspace(t,{'parent/README.md':fm('1'),'parent/a.md':fm('2'),'ignored.md':fm('2'),'.confluence-syncignore':'ignored.md'});
 await runRemap(['remap','--base',root]);const m=load(root);assert.deepEqual(m['parent/a.md'].pendingMove,{parentKey:'parent/README.md'});assert.equal(m['ignored.md'],undefined);assert.equal(m['parent/a.md'].hash,undefined);
});

test('CLI remap needs no credentials and dry-run creates no mapping',t=>{
 const {root}=workspace(t,{'a.md':fm('1')});const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('CONFLUENCE_'))delete env[key];
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../dist/sync.js',import.meta.url)),'remap','--base',root,'--dry-run'],{cwd:root,env,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Confluence 호출 없음/);assert.equal(existsSync(join(root,'.confluence-sync.json')),false);
});

test('sync dry-run displays pending move without calls or writes',async t=>{
 mockFetch(t,[]);const {root}=workspace(t,{'a.md':fm('1'),'.confluence-sync.json':JSON.stringify({'a.md':{pageId:'1',hash:'old',pendingMove:{parentKey:null}}})});
 const before=readFileSync(join(root,'.confluence-sync.json'),'utf8');await runPush(['--base',root,'--dry-run']);assert.equal(readFileSync(join(root,'.confluence-sync.json'),'utf8'),before);
});

test('push creates destination folder then moves existing page without uploading unchanged body or attachments',async t=>{
 configure(t);
 for(const key of ['CONFLUENCE_PARENT_ID','CONFLUENCE_PARENT_PAGE_ID']) {const old=process.env[key];delete process.env[key];t.after(()=>{if(old!==undefined)process.env[key]=old;});}
 const {root}=workspace(t,{'new/a.md':fm('1')});
 const {buildTreeRenderer}=await import('../dist/sync/render.js');const {readDoc}=await import('../dist/documents/catalog.js');const {docHash}=await import('../dist/documents/markdown.js');
 const d=readDoc(root,'new/a.md');const hash=docHash(d.title,buildTreeRenderer(root,['new/a.md']).render('new/a.md',d.body,d.title));
 const {writeFileSync}=await import('node:fs');writeFileSync(join(root,'.confluence-sync.json'),JSON.stringify({'old/a.md':{pageId:'1',title:'A',hash}}));
 mockFetch(t,[{path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}},{path:'/wiki/rest/api/content/search?cql='+encodeURIComponent('type = folder AND space = "TEST" AND title = "new"')+'&limit=100',body:{results:[]}},{path:'/wiki/api/v2/folders',method:'POST',body:{id:'folder'}},{path:'/wiki/api/v2/pages/1',body:{id:'1',spaceId:'space',parentId:'old'}},{path:'/wiki/rest/api/content/1/move/append/folder',method:'PUT',body:{pageId:'1'}},{path:'/wiki/api/v2/pages/1',body:{id:'1',spaceId:'space',parentId:'folder'}}]);
 await runRemap(['remap','--base',root]);await runPush(['--base',root]);assert.equal(load(root)['new/a.md'].pendingMove,undefined);assert.equal(load(root)['new/a.md'].hash,hash);
});

test('duplicate source mapping IDs cannot be hidden by import merging',async t=>{
 mockFetch(t,[]);const {root,put}=workspace(t,{'new.md':fm('1')});const source=put('source.json',JSON.stringify({'a.md':{pageId:'1'},'b.md':{pageId:'1'}}));
 await assert.rejects(runRemap(['remap','--base',root,'--from-mapping',source]),/중복/);assert.equal(existsSync(join(root,'.confluence-sync.json')),false);
});

test('tree changes after remap require a fresh plan before any sync call',async t=>{
 mockFetch(t,[]);const {root,put}=workspace(t,{'new/a.md':fm('1')});await runRemap(['remap','--base',root]);put('new/README.md',fm('2'));
 await assert.rejects(runPush(['--base',root,'--dry-run']),/remap 이후/);
});
