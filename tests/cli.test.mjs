import {bindScope} from './helpers/scope.mjs';
import {mappingPath} from '../dist/sync/metadata.js';
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
 bindScope(args.includes('--base')?args[args.indexOf('--base')+1]:root);
 const responses=put('responses.json',JSON.stringify(steps));const calls=put('calls.jsonl','');
 const r=run(root,args,{NODE_OPTIONS:`--import=${preload}`,CSYNC_TEST_RESPONSES:responses,CSYNC_TEST_CALLS:calls,CSYNC_TEST_SCOPE_BASE:args.includes('--base')?args[args.indexOf('--base')+1]:root,CONFLUENCE_BASE_URL:'https://example.invalid/wiki',CONFLUENCE_EMAIL:'test@example.invalid',CONFLUENCE_API_TOKEN:'fake',CONFLUENCE_SPACE_KEY:'TEST'});
 return {...r,calls:readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)};
}

test('version and help work without credentials or a base directory',t=>{
 const {root}=workspace(t);assert.equal(run(root,['--version']).stdout.trim(),version);const help=run(root,['--help']);assert.equal(help.status,0);assert.match(help.stdout,/convert/);
});

test('push refuses missing base and missing authentication',t=>{
 const {root}=workspace(t,{'doc.md':'# Doc'});assert.notEqual(run(root,[]).status,0);const r=run(root,['--base',root]);assert.notEqual(r.status,0);assert.match(r.stderr,/스코프/);
});

test('init generates a template and refuses an accidental overwrite',t=>{
 const {root}=workspace(t);assert.equal(run(root,['init']).status,0);const before=readFileSync(join(root,'.env'),'utf8');assert.match(before,/CONFLUENCE_BASE_URL=/);
 assert.notEqual(run(root,['init']).status,0);assert.equal(readFileSync(join(root,'.env'),'utf8'),before);assert.equal(run(root,['init','--force']).status,0);
});

test('list and dry-run respect exclusions and do not call the API or write mapping',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc','private/no.md':'# Hidden'});
 for(const flag of ['--list','--dry-run']) {const r=offline(root,put,['--base',root,flag,'--exclude','private/'],[]);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/doc.md/);assert.doesNotMatch(r.stdout,/no.md/);}
 assert.equal(existsSync(mappingPath(root)),false);
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
 let r=offline(root,put,['--base',root],[space,{path:'/wiki/api/v2/pages',method:'POST',body:{id:'page'}}]);assert.equal(r.status,0,r.stderr);assert.equal(r.calls[1].body.title,'Doc');assert.equal(JSON.parse(readFileSync(mappingPath(root),'utf8'))['doc.md'].pageId,'page');
 r=offline(root,put,['--base',root],[space]);assert.equal(r.status,0,r.stderr);assert.equal(r.calls.length,1);
 put('doc.md','# Doc\n\nChanged');r=offline(root,put,['--base',root],[space,{path:'/wiki/api/v2/pages/page',body:{version:{number:1}}},{path:'/wiki/api/v2/pages/page',body:{version:{number:1}}},{path:'/wiki/api/v2/pages/page',method:'PUT'}]);assert.equal(r.status,0,r.stderr);assert.equal(r.calls.at(-1).body.version.number,2);assert.match(r.calls.at(-1).body.body.value,/Changed/);
});

test('frontmatter identity without a remote baseline cannot overwrite an existing page',t=>{
 const {root,put}=workspace(t,{'doc.md':'---\npageId: existing\n---\n# Doc\n\nBody'});
 const r=offline(root,put,['--base',root],[{path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}},{path:'/wiki/api/v2/pages/existing',body:{version:{number:2}}}]);
 assert.equal(r.status,1,r.stderr);assert.match(r.stderr,/버전 기준이 없습니다/);assert.equal(existsSync(mappingPath(root)),false);
});

test('push creates folder containers before pages and records their parent relationship',t=>{
 const {root,put}=workspace(t,{'folder/doc.md':'# Doc'});
 const r=offline(root,put,['--base',root],[{path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}},{path:'/wiki/rest/api/content/search?cql='+encodeURIComponent('type = folder AND space = "TEST" AND title = "folder"')+'&limit=100',body:{results:[]}},{path:'/wiki/api/v2/folders',method:'POST',body:{id:'folder'}},{path:'/wiki/api/v2/pages',method:'POST',body:{id:'doc'}}]);
 assert.equal(r.status,0,r.stderr);assert.equal(r.calls[3].body.parentId,'folder');const m=JSON.parse(readFileSync(mappingPath(root),'utf8'));assert.equal(m['folder/'].type,'folder');assert.equal(m['folder/doc.md'].pageId,'doc');
});

test('selected push uses a mapped ancestor README without publishing its changed contents',t=>{
 const {root,put}=workspace(t,{'guide/README.md':'# Guide\n\nUnselected change','guide/doc.md':'# Doc','.confluence-sync.json':JSON.stringify({'guide/README.md':{pageId:'parent',hash:'old'}})});
 const r=offline(root,put,['--base',root,'guide/doc.md'],[{path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}},{path:'/wiki/api/v2/pages',method:'POST',body:{id:'child'}}]);assert.equal(r.status,0,r.stderr);assert.equal(r.calls[1].body.parentId,'parent');assert.equal(JSON.parse(readFileSync(mappingPath(root),'utf8'))['guide/README.md'].hash,'old');
});

test('verify refuses deleted targets before any mutation and keeps mappings',t=>{
 const {root,put}=workspace(t,{'a.md':'# A\n\n[B](b.md)','b.md':'# B'});
 const space={path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}};
 let r=offline(root,put,['--base',root],[space,{path:'/wiki/api/v2/pages',method:'POST',body:{id:'a'}},{path:'/wiki/api/v2/pages',method:'POST',body:{id:'b'}}]);assert.equal(r.status,0,r.stderr);
 const before=readFileSync(mappingPath(root),'utf8');
 r=offline(root,put,['--base',root,'--verify'],[space,{path:'/wiki/api/v2/pages/a',body:{version:{number:1}}},{path:'/wiki/api/v2/pages/b',status:404}]);
 assert.equal(r.status,1,r.stderr);assert.match(r.stderr,/자동 재생성하지/);assert.ok(r.calls.every(call=>call.method==='GET'));
 assert.equal(readFileSync(mappingPath(root),'utf8'),before);
});

test('rebuild cannot delete the selected scope or its mapped content',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc','.confluence-sync.json':JSON.stringify({'doc.md':{pageId:'old',hash:'old'}})});
 const r=offline(root,put,['--base',root,'--rebuild'],[]);assert.equal(r.status,1);assert.match(r.stderr,/rebuild/);
 assert.equal(JSON.parse(readFileSync(mappingPath(root),'utf8'))['doc.md'].pageId,'old');
});

test('convert rejects output inside the input tree even through a directory symlink',t=>{
 const {root,put}=workspace(t,{'source/doc.md':'# Doc'});const input=join(root,'source');const alias=join(root,'alias');symlinkSync(input,alias,'junction');
 const r=run(root,['convert','--to','markdown','--base',input,join(input,'doc.md'),'--out',join(alias,'out')]);assert.notEqual(r.status,0);assert.match(r.stderr,/--out/);assert.equal(existsSync(join(input,'out')),false);
});

test('reference pages link by ID without any reference upload or mapping mutation',t=>{
 const original=JSON.stringify({'target.md':{pageId:'123',title:'Previous title'}});
 const {root,put}=workspace(t,{'main/a.md':'# A\n\n[[Vault/old/target|Alias]]','refs/target.md':'# Different H1','refs/.confluence-sync.json':original});
 const r=offline(root,put,['--base',join(root,'main'),'--reference-root',join(root,'refs')],[{path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}},{path:'/wiki/api/v2/pages',method:'POST',body:{id:'new'}}]);
 assert.equal(r.status,0,r.stderr);assert.equal(r.calls.length,2);
 assert.match(r.calls[1].body.body.value,/viewpage.action\?pageId=123/);assert.match(r.calls[1].body.body.value,/>Alias<\/a>/);
 assert.equal(readFileSync(join(root,'refs/.confluence-sync.json'),'utf8'),original);
 assert.deepEqual(Object.keys(JSON.parse(readFileSync(mappingPath(join(root,'main')),'utf8'))),['a.md']);
});

test('failed mapped folder blocks every child even while a stale mapping ID remains',t=>{
 const old=process.env.CONFLUENCE_PARENT_ID;process.env.CONFLUENCE_PARENT_ID='';t.after(()=>{if(old===undefined)delete process.env.CONFLUENCE_PARENT_ID;else process.env.CONFLUENCE_PARENT_ID=old;});
 const mapping={'folder/':{pageId:'f',type:'folder',title:'folder'}};
 const {root,put}=workspace(t,{'folder/a.md':'# A','folder/b.md':'# B','.confluence-sync.json':JSON.stringify(mapping)});
 const r=offline(root,put,['--base',root],[{path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}},{path:'/wiki/rest/api/content/f?expand=ancestors,space',body:{id:'f',type:'folder',title:'renamed',space:{id:'space'},ancestors:[{id:'home'}]}}]);
 assert.equal(r.calls.length,2);assert.match(r.stderr,/folder\/a.md/);assert.match(r.stderr,/folder\/b.md/);
 assert.deepEqual(JSON.parse(readFileSync(mappingPath(root),'utf8')),mapping);
});

test('push uploads linked files once, retries failure, skips unchanged and detects file-only edits',t=>{
 const {root,put}=workspace(t,{'doc.md':'# Doc\n\n[PDF](report.pdf) [again](report.pdf)','report.pdf':'first'});
 const space={path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space'}]}};
 const lookup={path:'/wiki/rest/api/content/page/child/attachment?filename=report.pdf',body:{results:[]}};
 const upload={path:'/wiki/rest/api/content/page/child/attachment',method:'POST'};
 const update=number=>[{path:'/wiki/api/v2/pages/page',body:{version:{number}}},{path:'/wiki/api/v2/pages/page',body:{version:{number}}},{path:'/wiki/api/v2/pages/page',method:'PUT'}];
 let r=offline(root,put,['--base',root],[space,{path:'/wiki/api/v2/pages',method:'POST',body:{id:'page'}},lookup,{...upload,status:500}]);
 assert.equal(r.status,1,r.stderr);assert.match(r.calls[1].body.body.value,/ri:attachment ri:filename="report.pdf"/);
 assert.equal(JSON.parse(readFileSync(mappingPath(root),'utf8'))['doc.md'].hash,undefined);
 r=offline(root,put,['--base',root],[space,...update(1),lookup,upload]);assert.equal(r.status,0,r.stderr);assert.equal(r.calls.length,6);
 r=offline(root,put,['--base',root],[space]);assert.equal(r.status,0,r.stderr);assert.equal(r.calls.length,1);
 put('report.pdf','second');r=offline(root,put,['--base',root],[space,...update(2),{...lookup,body:{results:[{id:'att'}]}},{path:upload.path+'/att/data',method:'POST'}]);
 assert.equal(r.status,0,r.stderr);assert.equal(r.calls.length,6);
});
