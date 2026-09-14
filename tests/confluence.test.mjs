import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '../dist/confluence.js';
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
 }}]);const m={};assert.equal(await client().upsertPage(m,'space','a.md','A','<p>A</p>','hash','parent'),'created');assert.deepEqual(m['a.md'],{pageId:'new',title:'A',hash:'hash'});
});

test('changed page increments server version and preserves mapping until update succeeds',async t=>{
 mockFetch(t,[{path:page+'/1',body:{version:{number:7}}},{path:page+'/1',method:'PUT',check:r=>assert.equal(JSON.parse(r.body).version.number,8)}]);
 const m={'a.md':{pageId:'1',hash:'old'}};assert.equal(await client().upsertPage(m,'space','a.md','A','new','new'),'updated');assert.equal(m['a.md'].hash,'new');
});

test('failed update leaves prior mapping untouched',async t=>{
 mockFetch(t,[{path:page+'/1',body:{version:{number:2}}},{path:page+'/1',method:'PUT',status:409,body:{message:'conflict'}}]);const m={'a.md':{pageId:'1',hash:'old'}};
 await assert.rejects(client().upsertPage(m,'space','a.md','A','new','new'),/409/);assert.equal(m['a.md'].hash,'old');
});

test('verify checks unchanged pages and recreates a deleted page',async t=>{
 mockFetch(t,[{path:page+'/1',status:404},{path:page,method:'POST',body:{id:'2'}}]);const m={'a.md':{pageId:'1',hash:'same'}};
 assert.equal(await client({verify:true}).upsertPage(m,'space','a.md','A','body','same'),'recreated');assert.equal(m['a.md'].pageId,'2');
});

test('verify retains existing unchanged page without PUT',async t=>{
 mockFetch(t,[{path:page+'/1',body:{id:'1'}}]);assert.equal(await client({verify:true}).upsertPage({'a.md':{pageId:'1',hash:'same'}},'space','a.md','A','body','same'),'skipped');
});

for(const opts of [{force:true},{force:false}])test(`forced update overrides identical hashes (${opts.force?'global':'per-call'})`,async t=>{
 mockFetch(t,[{path:page+'/1',body:{version:{number:1}}},{path:page+'/1',method:'PUT'}]);
 assert.equal(await client(opts).upsertPage({'a.md':{pageId:'1',hash:'same'}},'space','a.md','A','body','same',undefined,!opts.force),'updated');
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
