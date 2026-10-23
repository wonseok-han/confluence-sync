import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '../dist/confluence/client.js';
import {workspace,mockFetch} from './helpers/fixtures.mjs';
const client=(opts={})=>createClient({baseUrl:'https://example.invalid/wiki',email:'test@example.invalid',token:'fake'},{force:false,verify:false,...opts});
const page='/wiki/api/v2/pages';

test('unchanged page skips without any network access',async t=>{
 mockFetch(t,[]);const m={'a.md':{pageId:'1',hash:'same'}};
 assert.equal(await client().upsertPage(m,'space','a.md','A','<p>A</p>','same'),'skipped');
});

test('new page sends storage and parent, then records the returned id',async t=>{
 mockFetch(t,[{path:page,method:'POST',body:{id:'new'},check:r=>{
  const b=JSON.parse(r.body);assert.equal(b.parentId,'parent');assert.equal(b.spaceId,'space');assert.deepEqual(b.body,{representation:'storage',value:'<p>A</p>'});assert.match(r.headers.Authorization,/^Basic /);
 }}]);const m={};assert.equal(await client().upsertPage(m,'space','a.md','A','<p>A</p>','hash','parent'),'created');assert.deepEqual(m['a.md'],{pageId:'new',title:'A',hash:'hash',remoteVersion:1});
});

test('changed page increments server version and preserves mapping until update succeeds',async t=>{
 mockFetch(t,[{path:page+'/1',body:{version:{number:7}}},{path:page+'/1',method:'PUT',check:r=>assert.equal(JSON.parse(r.body).version.number,8)}]);
 const m={'a.md':{pageId:'1',hash:'old',remoteVersion:7}};assert.equal(await client().upsertPage(m,'space','a.md','A','new','new'),'updated');assert.equal(m['a.md'].hash,'new');
});

test('failed update leaves prior mapping untouched',async t=>{
 mockFetch(t,[{path:page+'/1',body:{version:{number:2}}},{path:page+'/1',method:'PUT',status:409,body:{message:'conflict'}}]);const m={'a.md':{pageId:'1',hash:'old',remoteVersion:2}};
 await assert.rejects(client().upsertPage(m,'space','a.md','A','new','new'),/409/);assert.equal(m['a.md'].hash,'old');
});

test('verify refuses a deleted mapped page without recreating it',async t=>{
 mockFetch(t,[{path:page+'/1',status:404}]);const m={'a.md':{pageId:'1',hash:'same',remoteVersion:1}};
 await assert.rejects(client({verify:true}).upsertPage(m,'space','a.md','A','body','same'),/자동 재생성하지/);assert.equal(m['a.md'].pageId,'1');
});

test('verify retains existing unchanged page without PUT',async t=>{
 mockFetch(t,[{path:page+'/1',body:{id:'1'}}]);assert.equal(await client({verify:true}).upsertPage({'a.md':{pageId:'1',hash:'same'}},'space','a.md','A','body','same'),'skipped');
});

for(const opts of [{force:true},{force:false}])test(`forced update overrides identical hashes (${opts.force?'global':'per-call'})`,async t=>{
 mockFetch(t,[{path:page+'/1',body:{version:{number:1}}},{path:page+'/1',method:'PUT'}]);
 assert.equal(await client(opts).upsertPage({'a.md':{pageId:'1',hash:'same',remoteVersion:1}},'space','a.md','A','body','same',undefined,!opts.force),'updated');
});

test('authorization errors must not be interpreted as deleted pages',async t=>{
 mockFetch(t,[{path:page+'/1',status:403}]);await assert.rejects(client().getPageOrNull('1'),/403/);
});

test('space lookup URL-encodes its key and returns homepage metadata',async t=>{
 mockFetch(t,[{path:'/wiki/api/v2/spaces?keys=A%20B',body:{results:[{id:'space',homepageId:'home'}]}}]);assert.deepEqual(await client().getSpaceInfo('A B'),{id:'space',homepageId:'home'});
});

test('unknown space fails clearly',async t=>{
 mockFetch(t,[{path:'/wiki/api/v2/spaces?keys=NONE',body:{results:[]}}]);await assert.rejects(client().getSpaceId('NONE'),/NONE/);
});

test('pull child lists follow pagination',async t=>{
 mockFetch(t,[{path:'/wiki/rest/api/content/1/child/page?limit=100',body:{results:[{id:'2',title:'A'}],_links:{next:'/rest/api/next'}}},{path:'/wiki/rest/api/next',body:{results:[{id:'3',title:'B'}]}}]);assert.deepEqual(await client().getChildPages('1'),[{id:'2',title:'A'},{id:'3',title:'B'}]);
});

test('pull attachment lists follow pagination and omit missing download links',async t=>{
 mockFetch(t,[{path:'/wiki/rest/api/content/1/child/attachment?limit=100',body:{results:[{title:'a.png',_links:{download:'/a'}}],_links:{next:'rest/api/next'}}},{path:'/wiki/rest/api/next',body:{results:[{title:'b.pdf',_links:{download:'/b'}},{title:'no'}]}}]);assert.deepEqual(await client().listAttachments('1'),[{filename:'a.png',downloadPath:'/a'},{filename:'b.pdf',downloadPath:'/b'}]);
});

test('content reads retain export HTML, storage, provenance and updated time',async t=>{
 mockFetch(t,[{path:'/wiki/rest/api/content/1?expand=body.export_view,body.storage,version',body:{id:'1',type:'page',title:'A',body:{export_view:{value:'<p>A</p>'},storage:{value:'<p>storage</p>'}},_links:{base:'https://example.invalid',webui:'/wiki/page'},version:{when:'2026-01-01'}}}]);
 assert.deepEqual(await client().getNode('1'),{id:'1',type:'page',title:'A',html:'<p>A</p>',storage:'<p>storage</p>',url:'https://example.invalid/wiki/page',updated:'2026-01-01'});
});

test('attachment download preserves binary bytes',async t=>{
 mockFetch(t,[{path:'/wiki/download/image',bytes:new Uint8Array([0,255,10,42])}]);assert.deepEqual(await client().downloadAttachment('/download/image'),Buffer.from([0,255,10,42]));
});

for(const existing of [false,true])test(`image upload ${existing?'updates existing attachment':'creates attachment'} using multipart bytes`,async t=>{
 const {root,put}=workspace(t);const abs=put('screen.png','image-bytes');
 mockFetch(t,[{path:'/wiki/rest/api/content/1/child/attachment?filename=screen.png',body:{results:existing?[{id:'att'}]:[]}},{path:'/wiki/rest/api/content/1/child/attachment'+(existing?'/att/data':''),method:'POST',check:r=>{assert.equal(r.headers['X-Atlassian-Token'],'nocheck');assert.ok(r.body instanceof FormData);assert.equal(r.body.get('file').name,'screen.png');assert.equal(r.body.get('file').size,11);}}]);
 assert.equal(await client().uploadImages('1',[{filename:'screen.png',abs}],root),1);
});

test('folder create/delete uses folder endpoints and accepts no-content success',async t=>{
 mockFetch(t,[{path:'/wiki/api/v2/folders',method:'POST',body:{id:'f'},check:r=>assert.equal(JSON.parse(r.body).parentId,'p')},{path:'/wiki/api/v2/folders/f',method:'DELETE',status:204}]);const c=client();assert.equal(await c.createFolder('space','Folder','p'),'f');await c.deleteFolder('f');
});

test('rebuild deletes pages before containing folders',async t=>{
 mockFetch(t,[{path:page+'/p',method:'DELETE',status:204},{path:'/wiki/api/v2/folders/f',method:'DELETE',status:204}]);await client().deleteAll({'folder/':{pageId:'f',type:'folder'},'folder/a.md':{pageId:'p'}});
});

test('missing images and failed upload are reported without claiming successful attachments',async t=>{
 const {root,put}=workspace(t);const abs=put('screen.png','bytes');t.mock.method(console,'error',()=>{});
 mockFetch(t,[{path:'/wiki/rest/api/content/1/child/attachment?filename=screen.png',body:{results:[]}},{path:'/wiki/rest/api/content/1/child/attachment',method:'POST',status:500}]);
 assert.equal(await client().uploadImages('1',[{filename:'missing.png',abs:abs+'.missing'},{filename:'screen.png',abs}],root),0);
});

test('failed binary download is reported as an error',async t=>{
 mockFetch(t,[{path:'/wiki/download/missing',status:404}]);await assert.rejects(client().downloadAttachment('/download/missing'),/download 404/);
});

const pending = () => ({'a.md':{pageId:'1',hash:'same',remoteVersion:1,pendingMove:{parentKey:'dest/'}}});
test('move-only sync verifies destination without a content update',async t=>{
 mockFetch(t,[{path:page+'/1?body-format=storage',body:{body:{storage:{value:'body'}},id:'1',spaceId:'space',parentId:'old',version:{number:1}}},{path:'/wiki/rest/api/content/1/move/append/dest',method:'PUT'},{path:page+'/1?body-format=storage',body:{body:{storage:{value:'body'}},id:'1',spaceId:'space',parentId:'dest',version:{number:2}}}]);
 const m=pending();assert.equal(await client().upsertPage(m,'space','a.md','A','body','same','dest'),'moved');assert.equal(m['a.md'].pendingMove,undefined);
});
test('already moved page clears pending plan without mutation',async t=>{
 mockFetch(t,[{path:page+'/1?body-format=storage',body:{body:{storage:{value:'body'}},spaceId:'space',parentId:'dest',version:{number:1}}}]);const m=pending();assert.equal(await client().upsertPage(m,'space','a.md','A','body','same','dest'),'skipped');assert.equal(m['a.md'].pendingMove,undefined);
});
test('move and content change uses fresh version after move',async t=>{
 mockFetch(t,[{path:page+'/1?body-format=storage',body:{body:{storage:{value:'body'}},spaceId:'space',parentId:'old',version:{number:1}}},{path:'/wiki/rest/api/content/1/move/append/dest',method:'PUT'},{path:page+'/1?body-format=storage',body:{body:{storage:{value:'body'}},spaceId:'space',parentId:'dest',version:{number:2}}},{path:page+'/1',method:'PUT',check:r=>assert.equal(JSON.parse(r.body).version.number,3)}]);
 const m=pending();assert.equal(await client().upsertPage(m,'space','a.md','A','body','new','dest'),'updated');assert.equal(m['a.md'].hash,'new');assert.equal(m['a.md'].pendingMove,undefined);
});
for(const status of [403,404])test(`missing or inaccessible remapped page ${status} never creates a replacement`,async t=>{
 mockFetch(t,[{path:page+'/1?body-format=storage',status}]);const m=pending();await assert.rejects(client().upsertPage(m,'space','a.md','A','body','same','dest'));assert.ok(m['a.md'].pendingMove);
});
test('failed move retains plan and original hash',async t=>{
 mockFetch(t,[{path:page+'/1?body-format=storage',body:{body:{storage:{value:'body'}},spaceId:'space',parentId:'old',version:{number:1}}},{path:'/wiki/rest/api/content/1/move/append/dest',method:'PUT',status:400}]);const m=pending();await assert.rejects(client().upsertPage(m,'space','a.md','A','body','new','dest'));assert.ok(m['a.md'].pendingMove);assert.equal(m['a.md'].hash,'same');
});
test('top-level move uses a verified top-level homepage sibling',async t=>{
 mockFetch(t,[{path:page+'/1?body-format=storage',body:{body:{storage:{value:'body'}},spaceId:'space',parentId:'old',version:{number:1}}},{path:'/wiki/api/v2/spaces/space',body:{homepageId:'home'}},{path:page+'/home',body:{body:{storage:{value:'body'}},spaceId:'space'}},{path:'/wiki/rest/api/content/1/move/after/home',method:'PUT'},{path:page+'/1?body-format=storage',body:{body:{storage:{value:'body'}},spaceId:'space'}}]);const m=pending();assert.equal(await client().upsertPage(m,'space','a.md','A','body','same'),'moved');
});

const folderSearch = title => '/wiki/rest/api/content/search?cql='+encodeURIComponent(`type = folder AND space = "TEST" AND title = ${JSON.stringify(title)}`)+'&limit=100';
for(const parentId of [undefined,'parent'])test(`folder reuse requires matching parent (${parentId??'root'})`,async t=>{
 mockFetch(t,[{path:folderSearch('센터_운영'),body:{results:[{id:'f',type:'folder',title:'센터_운영'}]}},{path:'/wiki/rest/api/content/f?expand=ancestors,space',body:{id:'f',type:'folder',space:{id:'space'},title:'센터_운영',ancestors:parentId?[{id:parentId}]:[]}}]);
 assert.equal(await client().findFolder('space','TEST','센터_운영',parentId),'f');
});
for(const mismatch of [{spaceId:'other',parentId:'parent'},{spaceId:'space',parentId:'other'}])test(`folder reuse rejects mismatching location ${JSON.stringify(mismatch)}`,async t=>{
 mockFetch(t,[{path:folderSearch('F'),body:{results:[{id:'f',type:'folder',title:'F'}]}},{path:'/wiki/rest/api/content/f?expand=ancestors,space',body:{id:'f',title:'F',type:'folder',space:{id:mismatch.spaceId},ancestors:[{id:mismatch.parentId}]}}]);
 if(mismatch.spaceId==='space') await assert.rejects(client().findFolder('space','TEST','F','parent'),/다른 위치/);
 else assert.equal(await client().findFolder('space','TEST','F','parent'),null);
});
test('folder lookup follows pagination and escapes quoted titles',async t=>{
 const title='운영 "규칙"';mockFetch(t,[{path:folderSearch(title),body:{results:[],_links:{next:'/wiki/rest/api/content/search?cursor=next'}}},{path:'/wiki/rest/api/content/search?cursor=next',body:{results:[{id:'f',type:'folder',title}]}},{path:'/wiki/rest/api/content/f?expand=ancestors,space',body:{id:'f',type:'folder',space:{id:'space'},ancestors:[],title}}]);
 assert.equal(await client().findFolder('space','TEST',title),'f');
});
test('folder lookup does not treat permission errors as absent',async t=>{
 mockFetch(t,[{path:folderSearch('F'),status:403}]);await assert.rejects(client().findFolder('space','TEST','F'),/403/);
});
test('folder lookup refuses missing ancestor metadata instead of assuming root',async t=>{
 mockFetch(t,[{path:folderSearch('F'),body:{results:[{id:'f',type:'folder',title:'F'}]}},{path:'/wiki/rest/api/content/f?expand=ancestors,space',body:{id:'f',type:'folder',title:'F',space:{id:'space'}}}]);
 await assert.rejects(client().findFolder('space','TEST','F'),/메타데이터/);
});

test('visible root folder under space homepage is reused without an explicit parent',async t=>{
 mockFetch(t,[{path:folderSearch('센터_운영'),body:{results:[{id:'2356150410',type:'folder',title:'센터_운영'}]}},{path:'/wiki/rest/api/content/2356150410?expand=ancestors,space',body:{id:'2356150410',type:'folder',title:'센터_운영',space:{id:1837760528},ancestors:[{id:'1837761398'}]}},{path:'/wiki/api/v2/spaces/1837760528',body:{homepageId:'1837761398'}}]);
 assert.equal(await client().findFolder('1837760528','TEST','센터_운영'),'2356150410');
});

const folderCandidate={id:'f',type:'folder',title:'F'};
const folderMetadata={...folderCandidate,space:{id:'space'},ancestors:[{id:'parent'}]};
const foundFolderSteps=()=>[{path:folderSearch('F'),body:{results:[folderCandidate]}},{path:'/wiki/rest/api/content/f?expand=ancestors,space',body:folderMetadata}];
test('folder upsert reuses existing folder without POST',async t=>{
 mockFetch(t,foundFolderSteps());assert.deepEqual(await client().upsertFolder('space','TEST','F','parent'),{id:'f',created:false});
});
test('folder upsert creates only when lookup is empty',async t=>{
 mockFetch(t,[{path:folderSearch('F'),body:{results:[]}},{path:'/wiki/api/v2/folders',method:'POST',body:{id:'new'}}]);
 assert.deepEqual(await client().upsertFolder('space','TEST','F','parent'),{id:'new',created:true});
});
for(const status of [400,409])test(`folder upsert recovers from create conflict ${status} by read-only lookup`,async t=>{
 mockFetch(t,[{path:folderSearch('F'),body:{results:[]}},{path:'/wiki/api/v2/folders',method:'POST',status,body:{errors:[{title:'A folder exists with the same title in this space'}]}},...foundFolderSteps()]);
 assert.deepEqual(await client().upsertFolder('space','TEST','F','parent'),{id:'f',created:false});
});
for(const status of [400,401,403,500])test(`folder upsert preserves non-duplicate create error ${status}`,async t=>{
 mockFetch(t,[{path:folderSearch('F'),body:{results:[]}},{path:'/wiki/api/v2/folders',method:'POST',status,body:{message:'other error'}}]);
 await assert.rejects(client().upsertFolder('space','TEST','F','parent'),new RegExp(String(status)));
});
test('unresolved conflict is not retried indefinitely',async t=>{
 mockFetch(t,[{path:folderSearch('F'),body:{results:[]}},{path:'/wiki/api/v2/folders',method:'POST',status:409},{path:folderSearch('F'),body:{results:[]}}]);
 await assert.rejects(client().upsertFolder('space','TEST','F','parent'),/409/);
});
test('mapped folder is verified and reused without search or creation',async t=>{
 mockFetch(t,[{path:'/wiki/rest/api/content/f?expand=ancestors,space',body:folderMetadata}]);
 assert.deepEqual(await client().upsertFolder('space','TEST','F','parent','f'),{id:'f',created:false});
});
test('missing mapped folder is not recreated',async t=>{
 mockFetch(t,[{path:'/wiki/rest/api/content/old?expand=ancestors,space',status:404}]);
 await assert.rejects(client().upsertFolder('space','TEST','F','parent','old'),/자동 재생성하지/);
});
test('mapped folder in wrong location is never silently reused or moved',async t=>{
 mockFetch(t,[{path:'/wiki/rest/api/content/f?expand=ancestors,space',body:{...folderMetadata,ancestors:[{id:'other'}]}}]);
 await assert.rejects(client().upsertFolder('space','TEST','F','parent','f'),/요청 위치와 다릅니다/);
});

for(const existing of [false,true])test(`general file attachment ${existing?'updates':'creates'} with original binary bytes`,async t=>{
 const {root,put}=workspace(t);const abs=put('report.pdf',Buffer.from([0,255,42,10]));let uploaded;
 mockFetch(t,[{path:'/wiki/rest/api/content/1/child/attachment?filename=report.pdf',body:{results:existing?[{id:'att'}]:[]}},{path:'/wiki/rest/api/content/1/child/attachment'+(existing?'/att/data':''),method:'POST',check:r=>{
  uploaded=r.body.get('file');assert.equal(uploaded.name,'report.pdf');
 }}]);
 assert.equal(await client().uploadAttachments('1',[{filename:'report.pdf',abs}],root),1);
 assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()),Buffer.from([0,255,42,10]));
});

test('rollback upload retries after re-querying and switches to existing attachment update',async t=>{
 const {root,put}=workspace(t);const abs=put('report.pdf','bytes');t.mock.method(console,'error',()=>{});
 const path='/wiki/rest/api/content/1/child/attachment';
 mockFetch(t,[{path:path+'?filename=report.pdf',body:{results:[]}},{path,method:'POST',status:500,body:{message:'UnexpectedRollbackException: rollback-only'}},{path:path+'?filename=report.pdf',body:{results:[{id:'att'}]}},{path:path+'/att/data',method:'POST'}]);
 assert.equal(await client().uploadAttachments('1',[{filename:'report.pdf',abs}],root),1);
});

test('persistent rollback stops after three attempts and reports failure',async t=>{
 const {root,put}=workspace(t);const abs=put('report.pdf','bytes');const errors=[];t.mock.method(console,'error',s=>errors.push(s));
 const path='/wiki/rest/api/content/1/child/attachment';
 mockFetch(t,Array.from({length:3},()=>[{path:path+'?filename=report.pdf',body:{results:[]}},{path,method:'POST',status:500,body:{message:'UnexpectedRollbackException: rollback-only'}}]).flat());
 assert.equal(await client().uploadAttachments('1',[{filename:'report.pdf',abs}],root),0);
 assert.match(errors.join('\n'),/POST \/rest\/api\/content\/1\/child\/attachment/);
});

for(const status of [401,403,500])test(`attachment lookup failure ${status} does not fall through to creation`,async t=>{
 const {root,put}=workspace(t);const abs=put('report.pdf','bytes');const errors=[];t.mock.method(console,'error',s=>errors.push(s));
 mockFetch(t,[{path:'/wiki/rest/api/content/1/child/attachment?filename=report.pdf',status}]);
 assert.equal(await client().uploadAttachments('1',[{filename:'report.pdf',abs}],root),0);assert.match(errors.join('\n'),new RegExp(String(status)));
});

for (const opts of [{}, {force:true}, {verify:true}]) test(`remote edits reject writes even with force/verify ${JSON.stringify(opts)}`,async t=>{
 const m={'a.md':{pageId:'1',hash:'old',remoteVersion:3}};
 mockFetch(t,[{path:page+'/1',body:{id:'1',spaceId:'space',version:{number:4}}}]);
 await assert.rejects(client(opts).upsertPage(m,'space','a.md','A','local','changed'),/원격 변경 충돌/);
 assert.deepEqual(m['a.md'],{pageId:'1',hash:'old',remoteVersion:3});
});
test('legacy mappings without remote versions cannot overwrite existing pages',async t=>{
 mockFetch(t,[{path:page+'/1',body:{version:{number:5}}}]);
 await assert.rejects(client().upsertPage({'a.md':{pageId:'1',hash:'old'}},'space','a.md','A','local','new'),/버전 기준이 없습니다/);
});
test('verify detects remote-only changes while preserving the baseline',async t=>{
 const m={'a.md':{pageId:'1',hash:'same',remoteVersion:1}};
 mockFetch(t,[{path:page+'/1',body:{version:{number:2}}}]);
 await assert.rejects(client({verify:true}).upsertPage(m,'space','a.md','A','body','same'),/원격 변경 충돌/);
 assert.equal(m['a.md'].remoteVersion,1);
});

test('a concurrent remote edit during a move is never adopted as a baseline or overwritten',async t=>{
 const m=pending();
 mockFetch(t,[
  {path:page+'/1?body-format=storage',body:{spaceId:'space',parentId:'old',version:{number:1},title:'A',body:{storage:{value:'before'}}}},
  {path:'/wiki/rest/api/content/1/move/append/dest',method:'PUT'},
  {path:page+'/1?body-format=storage',body:{spaceId:'space',parentId:'dest',version:{number:3},title:'A',body:{storage:{value:'concurrent edit'}}}},
 ]);
 await assert.rejects(client().upsertPage(m,'space','a.md','A','local','new','dest'),/이동 도중 원격/);
 assert.equal(m['a.md'].remoteVersion,1);assert.equal(m['a.md'].hash,'same');assert.ok(m['a.md'].pendingMove);
});
