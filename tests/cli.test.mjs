import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,existsSync,symlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {workspace} from './helpers/fixtures.mjs';
const version=JSON.parse(readFileSync(resolve('package.json'),'utf8')).version;
const cli=resolve('dist/sync.js');const preload=pathToFileURL(resolve('tests/helpers/fetch-preload.mjs')).href;
function run(root,args,extra={}) {
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CONFLUENCE_')));
 return spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',env:{...env,NO_COLOR:'1',...extra}});
}
function offline(root,put,args,steps) {
 const responses=put('responses.json',JSON.stringify(steps));const calls=put('calls.jsonl','');
 const r=run(root,args,{NODE_OPTIONS:`--import=${preload}`,CSYNC_TEST_RESPONSES:responses,CSYNC_TEST_CALLS:calls,CONFLUENCE_BASE_URL:'https://example.invalid/wiki',CONFLUENCE_EMAIL:'test@example.invalid',CONFLUENCE_API_TOKEN:'fake',CONFLUENCE_SPACE_KEY:'TEST'});
 return {...r,calls:readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)};
}

test('version and help work without credentials or a base directory',t=>{
 const {root}=workspace(t);assert.equal(run(root,['--version']).stdout.trim(),version);const help=run(root,['--help']);assert.equal(help.status,0);assert.match(help.stdout,/convert/);
});

test('push refuses missing base and missing authentication',t=>{
 const {root}=workspace(t,{'doc.md':'# Doc'});assert.notEqual(run(root,[]).status,0);const r=run(root,['--base',root]);assert.notEqual(r.status,0);assert.match(r.stderr,/CONFLUENCE_API_TOKEN/);
});

test('init generates a template and refuses an accidental overwrite',t=>{
 const {root}=workspace(t);assert.equal(run(root,['init']).status,0);const before=readFileSync(join(root,'.env'),'utf8');assert.match(before,/CONFLUENCE_BASE_URL=/);
 assert.notEqual(run(root,['init']).status,0);assert.equal(readFileSync(join(root,'.env'),'utf8'),before);assert.equal(run(root,['init','--force']).status,0);
});

test('list and dry-run respect exclusions and do not call the API or write mapping',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc','private/no.md':'# Hidden'});
 for(const flag of ['--list','--dry-run']) {const r=offline(root,put,['--base',root,flag,'--exclude','private/'],[]);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/doc.md/);assert.doesNotMatch(r.stdout,/no.md/);}
 assert.equal(existsSync(join(root,'.confluence-sync.json')),false);
});

test('convert validates direction, missing targets and output nested under source',t=>{
 const {root}=workspace(t,{'doc.md':'# Doc'});
 for(const args of [['--to','invalid'],['--to','markdown','missing.md'],['--to','markdown','doc.md','--out',join(root,'out')]])assert.notEqual(run(root,['convert',...args]).status,0);
});

test('convert exports only selected file under its base-relative path and preserves source',t=>{
 const {root,put}=workspace(t,{'source/folder/doc.md':'# Doc\n\n[[#Heading]]\n\n## Heading','source/other.md':'# Other'});const input=join(root,'source');const original=readFileSync(join(input,'folder/doc.md'),'utf8');
 const r=run(root,['convert','--to','markdown','--base',input,join(input,'folder/doc.md'),'--out',join(root,'out')]);assert.equal(r.status,0,r.stderr);assert.ok(existsSync(join(root,'out/folder/doc.md')));assert.equal(existsSync(join(root,'out/other.md')),false);assert.equal(readFileSync(join(input,'folder/doc.md'),'utf8'),original);
});

test('full push creates and persists a page; second push skips and content edit updates',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc\n\nOriginal'});const space={path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}};
 let r=offline(root,put,['--base',root],[space,{path:'/wiki/api/v2/pages',method:'POST',body:{id:'page'}}]);assert.equal(r.status,0,r.stderr);assert.equal(r.calls[1].body.title,'Doc');assert.equal(JSON.parse(readFileSync(join(root,'.confluence-sync.json'),'utf8'))['doc.md'].pageId,'page');
 r=offline(root,put,['--base',root],[space]);assert.equal(r.status,0,r.stderr);assert.equal(r.calls.length,1);
 put('doc.md','# Doc\n\nChanged');r=offline(root,put,['--base',root],[space,{path:'/wiki/api/v2/pages/page',body:{version:{number:4}}},{path:'/wiki/api/v2/pages/page',method:'PUT'}]);assert.equal(r.status,0,r.stderr);assert.equal(r.calls.at(-1).body.version.number,5);assert.match(r.calls.at(-1).body.body.value,/Changed/);
});

test('push uses frontmatter pageId to update an existing page instead of creating duplicates',t=>{
 const {root,put}=workspace(t,{'doc.md':'---\npageId: existing\n---\n# Doc\n\nBody'});
 const r=offline(root,put,['--base',root],[{path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}},{path:'/wiki/rest/api/content/existing',body:{id:'existing'}},{path:'/wiki/api/v2/pages/existing',body:{version:{number:2}}},{path:'/wiki/api/v2/pages/existing',method:'PUT'}]);assert.equal(r.status,0,r.stderr);assert.equal(r.calls.at(-1).body.id,'existing');
});

test('push creates folder containers before pages and records their parent relationship',t=>{
 const {root,put}=workspace(t,{'folder/doc.md':'# Doc'});
 const r=offline(root,put,['--base',root],[{path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}},{path:'/wiki/api/v2/folders',method:'POST',body:{id:'folder'}},{path:'/wiki/api/v2/pages',method:'POST',body:{id:'doc'}}]);
 assert.equal(r.status,0,r.stderr);assert.equal(r.calls[2].body.parentId,'folder');const m=JSON.parse(readFileSync(join(root,'.confluence-sync.json'),'utf8'));assert.equal(m['folder/'].type,'folder');assert.equal(m['folder/doc.md'].pageId,'doc');
});

test('selected push uses a mapped ancestor README without publishing its changed contents',t=>{
 const {root,put}=workspace(t,{'guide/README.md':'# Guide\n\nUnselected change','guide/doc.md':'# Doc','.confluence-sync.json':JSON.stringify({'guide/README.md':{pageId:'parent',hash:'old'}})});
 const r=offline(root,put,['--base',root,'guide/doc.md'],[{path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}},{path:'/wiki/api/v2/pages',method:'POST',body:{id:'child'}}]);assert.equal(r.status,0,r.stderr);assert.equal(r.calls[1].body.parentId,'parent');assert.equal(JSON.parse(readFileSync(join(root,'.confluence-sync.json'),'utf8'))['guide/README.md'].hash,'old');
});

test('verify recreates a deleted target and republishes its unchanged linking page',t=>{
 const {root,put}=workspace(t,{'a.md':'# A\n\n[B](b.md)','b.md':'# B'});
 const space={path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}};
 let r=offline(root,put,['--base',root],[space,{path:'/wiki/api/v2/pages',method:'POST',body:{id:'a'}},{path:'/wiki/api/v2/pages',method:'POST',body:{id:'b'}}]);assert.equal(r.status,0,r.stderr);
 r=offline(root,put,['--base',root,'--verify'],[space,{path:'/wiki/api/v2/pages/a',body:{version:{number:1}}},{path:'/wiki/api/v2/pages/b',status:404},{path:'/wiki/api/v2/pages',method:'POST',body:{id:'new-b'}},{path:'/wiki/api/v2/pages/a',body:{version:{number:1}}},{path:'/wiki/api/v2/pages/a',method:'PUT'}]);
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/링크 재연결/);assert.equal(JSON.parse(readFileSync(join(root,'.confluence-sync.json'),'utf8'))['b.md'].pageId,'new-b');
});

test('rebuild removes mapped content then creates a new page',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc','.confluence-sync.json':JSON.stringify({'doc.md':{pageId:'old',hash:'old'}})});
 const r=offline(root,put,['--base',root,'--rebuild'],[{path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}},{path:'/wiki/api/v2/pages/old',method:'DELETE',status:204},{path:'/wiki/api/v2/pages',method:'POST',body:{id:'new'}}]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(readFileSync(join(root,'.confluence-sync.json'),'utf8'))['doc.md'].pageId,'new');
});

test('convert rejects output inside the input tree even through a directory symlink',t=>{
 const {root,put}=workspace(t,{'source/doc.md':'# Doc'});const input=join(root,'source');const alias=join(root,'alias');symlinkSync(input,alias,'junction');
 const r=run(root,['convert','--to','markdown','--base',input,join(input,'doc.md'),'--out',join(alias,'out')]);assert.notEqual(r.status,0);assert.match(r.stderr,/--out/);assert.equal(existsSync(join(input,'out')),false);
});
