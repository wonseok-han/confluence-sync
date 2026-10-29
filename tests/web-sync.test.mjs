import {changeStaging} from '../dist/sync/staging.js';
import {bindScope} from './helpers/scope.mjs';
import {mappingPath,workspacePath} from '../dist/sync/metadata.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createWebSync } from '../dist/web/sync.js';
import { startWeb } from '../dist/web/server.js';
import { workspace, mockFetch } from './helpers/fixtures.mjs';

const env = 'CONFLUENCE_BASE_URL=https://example.invalid/wiki\nCONFLUENCE_EMAIL=demo@example.invalid\nCONFLUENCE_API_TOKEN=synthetic-secret\nCONFLUENCE_SPACE_KEY=TEST\nCONFLUENCE_PARENT_ID=123\n';
const request = async root => { if(!existsSync(workspacePath(root)))bindScope(root,{scope:{id:'123',type:'folder',path:'/Patents'}}); try { if(!existsSync(join(root,'.csync/index.json'))) await changeStaging(root,['.'],'add',{baseUrl:'https://example.invalid/wiki'}); } catch {} return { base: root, target: '', envId: '', verify: false }; };
async function finished(sync) {
  for (let i = 0; i < 300; i++) {
    if (!sync.running()) return sync.current();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('job did not complete');
}

test('sync config uses selected .env exclusively and never exposes token', async t => {
  const { root, put } = workspace(t, { '.env': env, 'a.md': '# A' });
  const sync = createWebSync();
  const config = await sync.config(root, '');
  assert.equal(config.spaceKey, 'TEST'); assert.equal(config.connected, false);assert.equal('parentId' in config,false); assert.equal(config.hasToken, true);
  assert.ok(!JSON.stringify(config).includes('synthetic-secret'));
  const custom = put('other.env', 'CONFLUENCE_SPACE_KEY=OTHER');
  const imported = await sync.importEnv({base:root,text:readFileSync(custom,'utf8'),name:'other.env'});
  const partial = await sync.config(root, imported.envId);
  assert.equal(partial.spaceKey, 'OTHER'); assert.equal(partial.hasToken, false);
  assert.ok(partial.missing.includes('CONFLUENCE_API_TOKEN'));
  await assert.rejects(sync.config(root, join(root, 'missing.env')), /다시 가져오세요/);
});

test('real CLI dry run covers the workspace, ignores and hierarchy without changing files', async t => {
  const { root } = workspace(t, { '.env': env, 'README.md': '# Parent', 'guide/a.md': '# A\n\n[[README]]', 'ignored.md': '# Ignore', '.confluence-syncignore': 'ignored.md' });
  const sync = createWebSync();
  await sync.preview(await request(root));
  const result = await finished(sync);
  assert.equal(result.state, 'succeeded'); assert.ok(result.planId);
  assert.match(result.log, /guide\/a.md/); assert.doesNotMatch(result.log, /ignored.md/);
  assert.match(result.log, /실제 호출 없음/);
  assert.equal(existsSync(mappingPath(root)), false);
  assert.equal(readFileSync(join(root, 'guide/a.md'), 'utf8'), '# A\n\n[[README]]');
});

test('push needs a successful single-use preview and passes only incremental CLI arguments', async t => {
  const { root } = workspace(t, { '.env': env, 'a.md': '# A' });
  const calls = [];
  const sync = createWebSync(async (args, settings, log) => { calls.push({ args, settings }); log('완료\n'); return 0; });
  await assert.rejects(sync.push('unknown'), /미리보기/);
  await sync.preview({ ...await request(root), verify: true });
  const { planId } = await finished(sync);
  await sync.push(planId); assert.equal((await finished(sync)).state, 'succeeded');
  assert.ok(calls[0].args.includes('--dry-run'));
  assert.deepEqual(calls[1].args, ['push', '--base', realpathSync.native(root), '--verify']);
  assert.equal(calls[1].settings.CONFLUENCE_API_TOKEN, 'synthetic-secret');
  await assert.rejects(sync.push(planId), /미리보기/);
});

test('document, mapping, attachment or configuration changes invalidate preview', async t => {
  for (const [path, before, after] of [['a.md', '# A', '# Updated'], ['.env', env, env.replace('TEST', 'OTHER')], ['asset.png', 'original', 'changed asset'], ['.confluence-sync.json', '{}', '{"a.md":{"pageId":"123"}}']]) {
    const { root, put } = workspace(t, { '.env': env, 'a.md': '# A', [path]: before });
    let pushes = 0;
    const sync = createWebSync(async args => { if (!args.includes('--dry-run')) pushes++; return 0; });
    await sync.preview(await request(root)); const { planId } = await finished(sync);
    put(path, after);
    await assert.rejects(sync.push(planId), /변경/); assert.equal(pushes, 0);
  }
});

test('validation rejects empty, escaped, corrupt mapping and missing credentials before push', async t => {
  const { root, put } = workspace(t, { 'vault/a.md': '# A', 'outside.md': '# Outside', 'empty/.keep': '' });
  const sync = createWebSync(async () => 0);
  const body = await request(join(root, 'vault'));
  await assert.rejects(sync.preview({ ...body, target: join(root, 'outside.md') }), /기준 폴더/);
  await assert.rejects(sync.preview(await request(join(root, 'empty'))), /문서가 없습니다/);
  put('vault/.confluence-sync.json', '{broken');
  await assert.rejects(sync.preview(body), /매핑/);
  put('vault/.confluence-sync.json', '{}'); put('vault/.env', 'CONFLUENCE_SPACE_KEY=TEST');
  await sync.preview(body); const { planId } = await finished(sync);
  await assert.rejects(sync.push(planId), /설정 누락/);
  symlinkSync(join(root, 'outside.md'), join(root, 'vault/link.md'));
  await assert.rejects(sync.preview({ ...body, target: join(root, 'vault/link.md') }), /기준 폴더/);
});

test('concurrent jobs are rejected and partial CLI failures or crashes leave sync reusable', async t => {
  const { root } = workspace(t, { '.env': env, 'a.md': '# A' });
  let release;
  const sync = createWebSync(async (_args, _env, log) => { await new Promise(resolve => { release = resolve; }); log('✗ 이미지 업로드 실패\n'); return 0; });
  await sync.preview(await request(root));
  await assert.rejects(sync.preview(await request(root)), /진행 중/);
  release(); assert.equal((await finished(sync)).state, 'failed'); assert.equal(sync.current().planId, null);
  await sync.preview(await request(root)); release(); await finished(sync);
  const crashing = createWebSync(async () => { throw Error('worker failed'); });
  await crashing.preview(await request(root)); assert.equal((await finished(crashing)).state, 'failed');
  assert.match(crashing.current().log, /worker failed/);
});

test('logs mask credentials and basic auth even in worker errors', async t => {
  const { root } = workspace(t, { '.env': env, 'a.md': '# A' });
  const sync = createWebSync(async (_args, settings, log) => {
    log('token=' + settings.CONFLUENCE_API_TOKEN + '\n');
    throw Error(Buffer.from('demo@example.invalid:synthetic-secret').toString('base64'));
  });
  await sync.preview(await request(root)); const job = await finished(sync);
  assert.equal(job.state, 'failed');
  assert.doesNotMatch(JSON.stringify(job), /synthetic-secret|ZGVtb0BleGFtcGxl/); assert.match(job.log, /비공개/);
});

test('sync HTTP endpoints require local token and serialize with conversion', async t => {
  const { root } = workspace(t, { '.env': env, 'a.md': '# A' });
  let release;
  const { server, url } = await startWeb({ start: root, port: 0, syncRunner: async () => { await new Promise(resolve => { release = resolve; }); return 0; } });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const html = await (await fetch(url)).text();
  const headers = { 'Content-Type': 'application/json', 'X-Csync-Token': html.match(/name="csync-token" content="([^"]+)"/)[1] };
  const post = (path, body) => fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await fetch(url + '/api/sync/job')).status, 403);
  assert.equal((await post('/api/sync/push', { planId: 'invalid' })).status, 400);
  const response = await post('/api/sync/preview', await request(root)); assert.equal(response.status, 202);
  const conflict = await post('/api/convert', {}); assert.equal(conflict.status, 409); assert.match((await conflict.json()).error, /업로드 미리보기/);
  assert.equal((await post('/api/sync/preview', await request(root))).status, 409);
  const job = await (await fetch(url + '/api/sync/job', { headers })).json(); assert.equal(job.job.state, 'running');
  release();
  for (let i = 0; i < 100; i++) {
    const data = await (await fetch(url + '/api/sync/job', { headers })).json();
    if (data.job.state !== 'running') { assert.equal(data.job.state, 'succeeded'); return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('job still running');
});

test('web adapter runs real incremental push with all Confluence calls intercepted', async t => {
  const { root, put } = workspace(t, { 'vault/.env': env, 'vault/a.md': '# A\n\nBody' });
  const { runSyncCLI } = await import('../dist/web/sync.js');
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const calls = put('calls.jsonl', '');
  const sync = createWebSync((args, config, log) => {
    const steps = args.includes('--dry-run') ? [] : [
      { path: '/wiki/api/v2/spaces?keys=TEST', body: { results: [{ id: 'space' }] } },
      { path: '/wiki/api/v2/pages', method: 'POST', body: { id: 'page' } },
    ];
    const responses = put('responses.json', JSON.stringify(steps));
    return runSyncCLI(args, { ...config, NODE_OPTIONS: '--import=' + pathToFileURL(resolve('tests/helpers/fetch-preload.mjs')).href, CSYNC_TEST_RESPONSES: responses, CSYNC_TEST_CALLS: calls, CSYNC_TEST_SCOPE_BASE: args[args.indexOf('--base')+1] }, log);
  });
  const body = await request(join(root, 'vault'));
  await sync.preview(body); const preview = await finished(sync); assert.equal(preview.state, 'succeeded');
  assert.equal(readFileSync(calls, 'utf8'), '');
  await sync.push(preview.planId); assert.equal((await finished(sync)).state, 'succeeded');
  assert.equal(JSON.parse(readFileSync(mappingPath(join(root,'vault')), 'utf8'))['a.md'].pageId, 'page');
  const sent = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(sent.map(call => call.method), ['GET', 'POST']);
  assert.equal(sent[1].body.parentId, '123');
  await assert.rejects(sync.preview(body), /업로드 대상이 없습니다/);
  await changeStaging(body.base,['a.md'],'add',{baseUrl:'https://example.invalid/wiki'});
  await sync.preview(body); assert.match((await finished(sync)).log, /동일/);
});

test('reference folders pass to CLI and reference mapping changes invalidate preview', async t => {
  const { root, put } = workspace(t, { 'main/.env': env, 'main/a.md': '# A', 'ref/b.md': '# B', 'ref/.confluence-sync.json': '{"b.md":{"pageId":"123"}}' });
  const calls = [];
  const sync = createWebSync(async args => { calls.push(args); return 0; });
  const input = { ...await request(join(root, 'main')), referenceRoots: [join(root, 'ref')] };
  await sync.preview(input); const { planId } = await finished(sync);
  assert.deepEqual(calls[0].slice(3,5), ['--reference-root', realpathSync(join(root,'ref'))]);
  put('ref/.confluence-sync.json', '{"b.md":{"pageId":"456"}}');
  await assert.rejects(sync.push(planId), /변경/); assert.equal(calls.length,1);
  await assert.rejects(sync.preview({...input,referenceRoots:'invalid'}), /참조/);
});

test('remote scope metadata changes invalidate web preview and verify is shared with CLI', async t => {
 const {root,put}=workspace(t,{'.env':env,'a.md':'# A','b.md':'# B'});
 const calls=[];const sync=createWebSync(async args=>{calls.push(args);return 0;});
 const input=await request(root);await sync.preview({...input,verify:true});const preview=await finished(sync);
 assert.ok(calls[0].includes('--verify'));assert.ok(calls[0].includes('--dry-run'));
 const config=JSON.parse(readFileSync(join(root,'.csync/workspace.json'),'utf8'));config.scope.path='a.md';
 put('.csync/workspace.json',JSON.stringify(config));
 await assert.rejects(sync.push(preview.planId),/변경/);
});

test('web requires explicit scope selection and exposes no inferred scope from the env parent',async t=>{
 const {root}=workspace(t,{'.env':env,'doc.md':'# Doc'});const sync=createWebSync(async()=>0);
 assert.equal((await sync.config(root,'')).connected,false);
 await assert.rejects(sync.preview({base:root,target:'',envId:'',verify:false}),/스페이스 연결이 없습니다/);

 assert.equal(existsSync(join(root,'.csync')),false);
});

test('scope HTTP endpoints require the local token before accepting any remote tree request',async t=>{
 const {root}=workspace(t,{'.env':env,'doc.md':'# Doc'});const {server,url}=await startWeb({start:root,port:0});
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 for(const path of ['/api/sync/connect','/api/sync/env/import','/api/sync/env/save','/api/sync/pull']) {
  const response=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base:root,envId:'',scopeId:'123'})});
  assert.equal(response.status,403);
 }
});

test('web reconnect preserves mappings, strips old local scope and invalidates approval',async t=>{
 const {root}=workspace(t,{'.env':env,'doc.md':'# Doc','other.md':'# Other'});bindScope(root);const sync=createWebSync(async()=>0);mockFetch(t,[]);
 const config=await sync.connect({base:root,envId:''});assert.equal(config.connected,true);assert.equal(JSON.parse(readFileSync(workspacePath(root),'utf8')).scope,undefined);
 await changeStaging(root,['doc.md'],'add',{baseUrl:'https://example.invalid/wiki'});await sync.preview({base:root,target:'',envId:'',verify:false});const preview=await finished(sync);assert.ok(preview.planId);
 await sync.connect({base:root,envId:''});await assert.rejects(sync.push(preview.planId),/미리보기/);assert.equal(existsSync(mappingPath(root)),false);
});

test('workspace web settings never fall back to server credentials',async t=>{
 const {root}=workspace(t,{'a.md':'# A'});const before=process.env.CONFLUENCE_API_TOKEN;process.env.CONFLUENCE_API_TOKEN='server-secret';
 t.after(()=>{if(before===undefined)delete process.env.CONFLUENCE_API_TOKEN;else process.env.CONFLUENCE_API_TOKEN=before;});
 const config=await createWebSync().config(root,'');assert.equal(config.hasToken,false);assert.equal(config.missing.length,4);
});

test('import remains session-only, ignores unrelated keys and passes exact credentials to the CLI',async t=>{
 const {root}=workspace(t,{'.env':env,'a.md':'# A'});const original=readFileSync(join(root,'.env'),'utf8');const calls=[];
 const sync=createWebSync(async(args,settings,log)=>{calls.push(settings);log(settings.CONFLUENCE_API_TOKEN);return 0;});
 const imported=await sync.importEnv({base:root,text:env.replace('synthetic-secret','import-secret')+'UNRELATED=do-not-import\n',name:'.env.demo'});
 assert.ok(!JSON.stringify(imported).includes('import-secret'));assert.equal(readFileSync(join(root,'.env'),'utf8'),original);
 await sync.preview({...await request(root),envId:imported.envId});const job=await finished(sync);
 assert.equal(job.state,'succeeded');assert.equal(calls[0].CONFLUENCE_API_TOKEN,'import-secret');assert.equal(calls[0].UNRELATED,undefined);assert.ok(!job.log.includes('import-secret'));assert.ok(!JSON.stringify(job).includes('import-secret'));
 await assert.rejects(createWebSync().config(root,imported.envId),/다시 가져오세요/);
});

test('saving imported settings requires an unchanged file snapshot and preserves unrelated dotenv content',async t=>{
 const {root,put}=workspace(t,{'.env':'# Existing notes\nUNRELATED="multi\nline"\n'+env,'a.md':'# A'});const sync=createWebSync();
 const imported=await sync.importEnv({base:root,text:env.replace('synthetic-secret','new-secret'),name:'.env'});
 const body={base:root,envId:imported.envId};const before=readFileSync(join(root,'.env'),'utf8');const preview=await sync.saveEnv(body);
 assert.equal(preview.needsConfirmation,true);assert.equal(readFileSync(join(root,'.env'),'utf8'),before);
 put('.env',before+'# external edit\n');await assert.rejects(sync.saveEnv({...body,expectedHash:preview.expectedHash}),/変更|변경/);
 const fresh=await sync.saveEnv(body);await sync.saveEnv({...body,expectedHash:fresh.expectedHash});
 const saved=readFileSync(join(root,'.env'),'utf8');assert.match(saved,/# Existing notes/);assert.match(saved,/UNRELATED="multi\nline"/);assert.match(saved,/# external edit/);assert.match(saved,/new-secret/);assert.ok(!saved.includes('synthetic-secret'));
});

test('new env save is explicit and refuses symlink targets and incomplete imports',async t=>{
 const {root,put}=workspace(t,{'a.md':'# A'});const sync=createWebSync();const imported=await sync.importEnv({base:root,text:env,name:'.env'});const body={base:root,envId:imported.envId};
 const preview=await sync.saveEnv(body);assert.equal(preview.needsConfirmation,false);assert.equal(preview.expectedHash,null);assert.equal(existsSync(join(root,'.env')),false);
 await sync.saveEnv({...body,expectedHash:null});assert.match(readFileSync(join(root,'.env'),'utf8'),/synthetic-secret/);
 const other=workspace(t,{'a.md':'# A'});const target=other.put('outside.env','keep');symlinkSync(target,join(other.root,'.env'));
 await assert.rejects(sync.saveEnv({base:other.root,envId:imported.envId}),/심볼릭/);assert.equal(readFileSync(target,'utf8'),'keep');
 const partial=await sync.importEnv({base:root,text:'CONFLUENCE_SPACE_KEY=TEST',name:'.env'});await assert.rejects(sync.saveEnv({base:root,envId:partial.envId}),/필수 연결/);
});


test('web pull works with an empty local document folder and uses the shared CLI pull command',async t=>{
 const {root}=workspace(t,{'.env':env});bindScope(root);const calls=[];const sync=createWebSync(async(args,settings)=>{calls.push({args,settings});return 0;});
 await sync.pull({base:root,envId:''});const job=await finished(sync);
 assert.equal(job.kind,'pull');assert.equal(job.state,'succeeded');assert.deepEqual(calls[0].args,['pull','--base',realpathSync(root)]);assert.equal(calls[0].settings.CONFLUENCE_SPACE_KEY,'TEST');assert.equal(job.planId,null);
});

test('web receive format uses the shared CLI flag and rejects unsupported formats',async t=>{
 const {root,put}=workspace(t,{'.env':env,'a.md':'# Local'});bindScope(root);put('.csync/mapping.json',JSON.stringify({'a.md':{pageId:'456',remoteVersion:1}}));const calls=[];const sync=createWebSync(async args=>{calls.push(args);return 0}),body={base:root,envId:''};
 await assert.rejects(sync.pull({...body,format:'html'}),/내부 링크/);assert.equal(calls.length,0);
 await sync.pull({...body,format:'obsidian'});assert.equal((await finished(sync)).selection.format,'obsidian');assert.deepEqual(calls.at(-1),['pull','--base',realpathSync(root),'--obsidian']);
 const approval=await sync.restore({...body,path:'a.md',overwrite:true,format:'obsidian'});assert.equal(approval.format,'obsidian');await assert.rejects(sync.restore({...body,confirmationId:approval.confirmationId,format:'markdown'}),/다시 확인/);assert.equal(calls.length,1);
 const confirmed=await sync.restore({...body,path:'a.md',overwrite:true,format:'obsidian'});await sync.restore({...body,confirmationId:confirmed.confirmationId,format:'obsidian'});await finished(sync);assert.deepEqual(calls.at(-1),['restore','--base',realpathSync(root),'a.md','--overwrite','--obsidian']);assert.equal(readFileSync(join(root,'a.md'),'utf8'),'# Local');
});

test('web pull requires credentials and scope, excludes local selection, and invalidates push approval',async t=>{
 const {root}=workspace(t,{'.env':env,'a.md':'# A'});const calls=[];const sync=createWebSync(async args=>{calls.push(args);return 0;});
 await assert.rejects(sync.pull({base:root,envId:''}),/스페이스 연결/);const input=await request(root);await sync.preview(input);const preview=await finished(sync);assert.ok(preview.planId);
 await sync.pull({...input,target:'/outside',referenceRoots:['/outside'],verify:true});await finished(sync);assert.deepEqual(calls.at(-1),['pull','--base',realpathSync(root)]);await assert.rejects(sync.push(preview.planId),/미리보기/);
 const empty=workspace(t,{});bindScope(empty.root);await assert.rejects(sync.pull({base:empty.root,envId:''}),/설정 누락/);
});


test('web real CLI pull downloads remote docs and refuses to overwrite local edits',async t=>{
 const {root,put}=workspace(t,{'.env':env});await request(root);
 const {runSyncCLI}=await import('../dist/web/sync.js');const {pathToFileURL}=await import('node:url');const {resolve}=await import('node:path');
 const listing={path:'/wiki/api/v2/pages?space-id=space&status=current&limit=100',body:{results:[{id:'124',title:'Child',spaceId:'space',parentId:'123',version:{number:1}}]}};
 const steps=[listing,{path:'/wiki/rest/api/content/124?expand=body.export_view,body.storage,version',body:{id:'124',type:'page',title:'Child',version:{number:1},body:{export_view:{value:'<p>Remote body</p>'},storage:{value:'<p>Remote body</p>'}}}}];
 const responses=put('responses.json',JSON.stringify(steps)),calls=put('calls.jsonl','');
 const sync=createWebSync((args,config,log)=>runSyncCLI(args,{...config,NODE_OPTIONS:'--import='+pathToFileURL(resolve('tests/helpers/fetch-preload.mjs')).href,CSYNC_TEST_RESPONSES:responses,CSYNC_TEST_CALLS:calls,CSYNC_TEST_SCOPE_BASE:root},log));
 await sync.pull({base:root,envId:''});assert.equal((await finished(sync)).state,'succeeded');const path=join(root,'Child.md');assert.match(readFileSync(path,'utf8'),/Remote body/);
 put('Child.md',readFileSync(path,'utf8').replace('Remote body','Local edit'));const before=readFileSync(path,'utf8');put('responses.json',JSON.stringify([listing]));await sync.pull({base:root,envId:''});const preserved=await finished(sync);assert.equal(preserved.state,'succeeded');assert.equal(readFileSync(path,'utf8'),before);
 assert.ok(readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse).every(call=>call.method==='GET'));
});


test('web push refuses partial targets instead of silently changing the workspace scope',async t=>{
 const {root}=workspace(t,{'.env':env,'a.md':'# A','nested/b.md':'# B'});const calls=[];const sync=createWebSync(async args=>{calls.push(args);return 0;});const input=await request(root);
 await assert.rejects(sync.preview({...input,target:join(root,'a.md')}),/기준 폴더 전체/);await assert.rejects(sync.preview({...input,target:join(root,'nested')}),/기준 폴더 전체/);assert.equal(calls.length,0);
 await sync.preview(input);assert.equal((await finished(sync)).state,'succeeded');assert.deepEqual(calls[0],['push','--base',realpathSync(root),'--dry-run']);
});

test('Pull missing attachments completes with a warning count rather than a failed job',async t=>{
 const {root}=workspace(t,{'.env':env});bindScope(root);
 const sync=createWebSync(async(_args,_env,log)=>{log('[경고] 원격 첨부 누락 #1: missing.png\n');log('[경고 요약] 원격 첨부 2개를 로컬로 저장하지 못했습니다.\n');return 0;});
 await sync.pull({base:root,envId:''});const job=await finished(sync);
 assert.equal(job.state,'succeeded');assert.equal(job.warningCount,2);
});

test('scope save identifies pending mapping inspection even when no Pull/Push job exists, then releases its lock',async t=>{
 const {root}=workspace(t,{'.env':env});
 let release,entered;const gate=new Promise(resolve=>{release=resolve}),started=new Promise(resolve=>{entered=resolve});
 const nativeFetch=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(input,init)=>{
  const remote=new URL(input);
  if(remote.hostname!=='example.invalid')return nativeFetch(input,init);
  entered();await gate;
  const body=remote.pathname.includes('/spaces')?{results:[{id:'space',homepageId:'100'}]}:{id:'100',type:'page',title:'Home',space:{id:'space'},ancestors:[]};
  return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
 });
 const {server,url}=await startWeb({start:root,port:0});t.after(()=>{release();return new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})});
 const html=await(await fetch(url)).text(),headers={'Content-Type':'application/json','X-Csync-Token':html.match(/name="csync-token" content="([^"]+)"/)[1]};
 const body={base:root,envId:'',scopePath:'/'};
 const post=()=>fetch(url+'/api/sync/connect',{method:'POST',headers,body:JSON.stringify(body)});
 const first=post();await started;
 try {
  const conflict=await post();assert.equal(conflict.status,409);assert.match((await conflict.json()).error,/스페이스 연결 저장/);
  assert.equal((await(await fetch(url+'/api/sync/job',{headers})).json()).job,null);
 }finally{release();}
 assert.equal((await first).status,200);assert.equal((await post()).status,200);
});

test('web Fetch uses the shared CLI command without upload options or approval',async t=>{
 const {root}=workspace(t,{'.env':env});await request(root);const calls=[];
 const sync=createWebSync(async(args,settings,log)=>{calls.push({args,settings});log('이번 API 요청: 1회\n원격 변경 1\n');return 0});
 await sync.fetch({base:root,envId:'',target:'/outside',verify:true,referenceRoots:['/outside']});
 const job=await finished(sync);assert.equal(job.kind,'fetch');assert.equal(job.state,'succeeded');assert.equal(job.planId,null);assert.deepEqual(calls[0].args,['fetch','--base',realpathSync(root)]);assert.equal(calls[0].settings.CONFLUENCE_API_TOKEN,'synthetic-secret');
 await assert.rejects(sync.push('anything'),/미리보기/);
});

test('web Fetch requires a saved scope and connection, and serializes concurrent requests',async t=>{
 const {root}=workspace(t,{'.env':env});let release;const sync=createWebSync(()=>new Promise(resolve=>{release=resolve}));
 await assert.rejects(sync.fetch({base:root,envId:''}),/스페이스 연결/);await request(root);await sync.fetch({base:root,envId:''});
 await assert.rejects(sync.fetch({base:root,envId:''}),/진행 중/);await assert.rejects(sync.connect({base:root,envId:'',scopePath:'/'}),/진행 중/);release(0);await finished(sync);
});

test('HTTP Fetch endpoint returns a metadata job and preserves the source mapping',async t=>{
 const {root,put}=workspace(t,{'.env':env});await request(root);put('.csync/mapping.json',JSON.stringify({'doc.md':{pageId:'1',remoteVersion:1}}));const before=readFileSync(mappingPath(root),'utf8');
 const {server,url}=await startWeb({start:root,port:0,syncRunner:async(args,settings,log)=>{assert.equal(args[0],'fetch');log('원격 확인 완료\n');return 0}});t.after(()=>{server.closeAllConnections();server.close()});
 const token=(await(await fetch(url)).text()).match(/name="csync-token" content="([^"]+)"/)[1];
 const response=await fetch(url+'/api/sync/fetch',{method:'POST',headers:{'Content-Type':'application/json','X-CSync-Token':token,Origin:url},body:JSON.stringify({base:root,envId:''})});
 assert.equal(response.status,202);assert.equal((await response.json()).job.kind,'fetch');assert.equal(readFileSync(mappingPath(root),'utf8'),before);
});

test('web full Pull is explicit, validated and passed through to the CLI',async t=>{
 const {root}=workspace(t,{'.env':env});await request(root);const calls=[];const sync=createWebSync(async(args)=>{calls.push(args);return 0});
 await assert.rejects(sync.pull({base:root,envId:'',full:'yes'}),/전체 탐색/);
 await sync.pull({base:root,envId:'',full:true});await finished(sync);assert.deepEqual(calls[0],['pull','--base',realpathSync(root),'--full']);
 await sync.pull({base:root,envId:''});await finished(sync);assert.deepEqual(calls[1],['pull','--base',realpathSync(root)]);
});

test('web restore validates selected file, requires single-use confirmation and invokes the shared CLI',async t=>{
 const {root,put}=workspace(t,{'.env':env,'a.md':'# Local edits'});bindScope(root);put('.csync/mapping.json',JSON.stringify({'a.md':{pageId:'456',remoteVersion:1}}));const calls=[];const sync=createWebSync(async(args)=>{calls.push(args);return 0});const body={base:root,envId:''};
 await assert.rejects(sync.restore({...body,path:'a.md',overwrite:false}),/이미 존재/);await assert.rejects(sync.restore({...body,path:'a.md',overwrite:'true'}),/덮어쓰기/);
 const approval=await sync.restore({...body,path:'a.md',overwrite:true});assert.ok(approval.confirmationId);assert.equal(calls.length,0);assert.equal(readFileSync(join(root,'a.md'),'utf8'),'# Local edits');
 await sync.restore({...body,confirmationId:approval.confirmationId});assert.equal((await finished(sync)).state,'succeeded');assert.deepEqual(calls,[['restore','--base',realpathSync.native(root),'a.md','--overwrite']]);await assert.rejects(sync.restore({...body,confirmationId:approval.confirmationId}),/다시 확인/);
});

test('web restore confirmation refuses subsequent source changes and supports missing-only recovery',async t=>{
 const {root,put}=workspace(t,{'.env':env,'a.md':'# Edits'});bindScope(root);put('.csync/mapping.json',JSON.stringify({'a.md':{pageId:'456'},'README.md':{pageId:'100'}}));const calls=[];const sync=createWebSync(async args=>{calls.push(args);return 0}),body={base:root,envId:''};
 const approval=await sync.restore({...body,path:'a.md',overwrite:true});put('a.md','# Later edits');await assert.rejects(sync.restore({...body,confirmationId:approval.confirmationId}),/確認|바뀌었습니다/);assert.equal(calls.length,0);assert.equal(readFileSync(join(root,'a.md'),'utf8'),'# Later edits');
 const missing=await sync.restore({...body,path:'README.md',overwrite:false});await sync.restore({...body,confirmationId:missing.confirmationId});await finished(sync);assert.deepEqual(calls,[['restore','--base',realpathSync.native(root),'README.md']]);
});

test('HTTP restore rejects unauthenticated requests and starts only after confirmation',async t=>{
 const {root,put}=workspace(t,{'.env':env,'a.md':'# Edits'});bindScope(root);put('.csync/mapping.json',JSON.stringify({'a.md':{pageId:'456'}}));let calls=0;const {server,url}=await startWeb({start:root,port:0,syncRunner:async()=>{calls++;return 0}});t.after(()=>{server.closeAllConnections();server.close()});
 const body={base:root,envId:'',path:'a.md',overwrite:true};const rejected=await fetch(url+'/api/sync/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(rejected.status,403);const html=await(await fetch(url)).text(),token=html.match(/name="csync-token" content="([^"]+)"/)[1],headers={'Content-Type':'application/json','X-Csync-Token':token};
 const first=await fetch(url+'/api/sync/restore',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(first.status,200);assert.equal(calls,0);const {confirmationId}=await first.json();const second=await fetch(url+'/api/sync/restore',{method:'POST',headers,body:JSON.stringify({base:root,envId:'',confirmationId})});assert.equal(second.status,202);assert.equal((await second.json()).job.kind,'restore');
});

test('the downloadable env example contains blank configuration and never exports the workspace env',async t=>{
 const {root}=workspace(t,{'.env':env});const {server,url}=await startWeb({start:root,port:0});t.after(()=>{server.closeAllConnections();server.close()});const before=readFileSync(join(root,'.env'),'utf8');const response=await fetch(url+'/assets/confluence-env-example.txt');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/plain/);const text=await response.text();assert.match(text,/CONFLUENCE_BASE_URL=\r?\n/);assert.match(text,/CONFLUENCE_EMAIL=\r?\n/);assert.match(text,/CONFLUENCE_API_TOKEN=\r?\n/);assert.match(text,/CONFLUENCE_SPACE_KEY=\r?\n/);assert.doesNotMatch(text,/synthetic-secret|demo@example.invalid|--scope|CONFLUENCE_PARENT_ID/);assert.equal(readFileSync(join(root,'.env'),'utf8'),before);const html=await(await fetch(url)).text();assert.match(html,/download="confluence.env.example"/);assert.match(html,/id="sync-log-download"/);
});

test('exported job logs retain server masking on errors, including Basic credentials',async t=>{
 const {root}=workspace(t,{'.env':env});await request(root);const {formatJobLog}=await import('../src/web/client/download.js');const encoded=Buffer.from('demo@example.invalid:synthetic-secret').toString('base64');const sync=createWebSync(async(_args,_settings,log)=>{log('Token synthetic-secret\nBasic '+encoded+'\n');return 1});await sync.fetch({base:root,envId:''});const job=await finished(sync),output=formatJobLog(job);assert.equal(job.state,'failed');assert.match(output,/Token \[비공개\]/);assert.match(output,/Basic \[비공개\]/);assert.doesNotMatch(output,/synthetic-secret/);assert.equal(output.includes(encoded),false);
});
