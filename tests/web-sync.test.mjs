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
const request = root => { if(!existsSync(workspacePath(root)))bindScope(root,{scope:{id:'123',type:'folder',path:'/Patents'}}); return { base: root, target: '', envFile: '', verify: false }; };
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
  assert.equal(config.spaceKey, 'TEST'); assert.equal(config.scope, null);assert.equal('parentId' in config,false); assert.equal(config.hasToken, true);
  assert.ok(!JSON.stringify(config).includes('synthetic-secret'));
  const custom = put('other.env', 'CONFLUENCE_SPACE_KEY=OTHER');
  const partial = await sync.config(root, custom);
  assert.equal(partial.spaceKey, 'OTHER'); assert.equal(partial.hasToken, false);
  assert.ok(partial.missing.includes('CONFLUENCE_API_TOKEN'));
  await assert.rejects(sync.config(root, join(root, 'missing.env')), /읽을 수 없습니다/);
});

test('real CLI dry run respects selection, ignores and hierarchy without changing files', async t => {
  const { root } = workspace(t, { '.env': env, 'README.md': '# Parent', 'guide/a.md': '# A\n\n[[README]]', 'ignored.md': '# Ignore', '.confluence-syncignore': 'ignored.md' });
  const sync = createWebSync();
  await sync.preview({ ...request(root), target: join(root, 'guide') });
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
  await sync.preview({ ...request(root), target: join(root, 'a.md'), verify: true });
  const { planId } = await finished(sync);
  await sync.push(planId); assert.equal((await finished(sync)).state, 'succeeded');
  assert.ok(calls[0].args.includes('--dry-run'));
  assert.deepEqual(calls[1].args, ['--base', realpathSync.native(root), realpathSync.native(join(root, 'a.md')), '--verify']);
  assert.equal(calls[1].settings.CONFLUENCE_API_TOKEN, 'synthetic-secret');
  await assert.rejects(sync.push(planId), /미리보기/);
});

test('document, mapping, attachment or configuration changes invalidate preview', async t => {
  for (const [path, before, after] of [['a.md', '# A', '# Updated'], ['.env', env, env.replace('TEST', 'OTHER')], ['asset.png', 'original', 'changed asset'], ['.confluence-sync.json', '{}', '{"a.md":{"pageId":"123"}}']]) {
    const { root, put } = workspace(t, { '.env': env, 'a.md': '# A', [path]: before });
    let pushes = 0;
    const sync = createWebSync(async args => { if (!args.includes('--dry-run')) pushes++; return 0; });
    await sync.preview(request(root)); const { planId } = await finished(sync);
    put(path, after);
    await assert.rejects(sync.push(planId), /변경/); assert.equal(pushes, 0);
  }
});

test('validation rejects empty, escaped, corrupt mapping and missing credentials before push', async t => {
  const { root, put } = workspace(t, { 'vault/a.md': '# A', 'outside.md': '# Outside', 'empty/.keep': '' });
  const sync = createWebSync(async () => 0);
  const body = request(join(root, 'vault'));
  await assert.rejects(sync.preview({ ...body, target: join(root, 'outside.md') }), /기준 폴더/);
  await assert.rejects(sync.preview(request(join(root, 'empty'))), /문서가 없습니다/);
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
  await sync.preview(request(root));
  await assert.rejects(sync.preview(request(root)), /진행 중/);
  release(); assert.equal((await finished(sync)).state, 'failed'); assert.equal(sync.current().planId, null);
  await sync.preview(request(root)); release(); await finished(sync);
  const crashing = createWebSync(async () => { throw Error('worker failed'); });
  await crashing.preview(request(root)); assert.equal((await finished(crashing)).state, 'failed');
  assert.match(crashing.current().log, /worker failed/);
});

test('logs mask credentials and basic auth even in worker errors', async t => {
  const { root } = workspace(t, { '.env': env, 'a.md': '# A' });
  const sync = createWebSync(async (_args, settings, log) => {
    log('token=' + settings.CONFLUENCE_API_TOKEN + '\n');
    throw Error(Buffer.from('demo@example.invalid:synthetic-secret').toString('base64'));
  });
  await sync.preview(request(root)); const job = await finished(sync);
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
  const response = await post('/api/sync/preview', request(root)); assert.equal(response.status, 202);
  assert.equal((await post('/api/convert', {})).status, 409);
  assert.equal((await post('/api/sync/preview', request(root))).status, 409);
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
  const body = request(join(root, 'vault'));
  await sync.preview(body); const preview = await finished(sync); assert.equal(preview.state, 'succeeded');
  assert.equal(readFileSync(calls, 'utf8'), '');
  await sync.push(preview.planId); assert.equal((await finished(sync)).state, 'succeeded');
  assert.equal(JSON.parse(readFileSync(mappingPath(join(root,'vault')), 'utf8'))['a.md'].pageId, 'page');
  const sent = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(sent.map(call => call.method), ['GET', 'POST']);
  assert.equal(sent[1].body.parentId, '123');
  await sync.preview(body); assert.match((await finished(sync)).log, /동일/);
});

test('reference folders pass to CLI and reference mapping changes invalidate preview', async t => {
  const { root, put } = workspace(t, { 'main/.env': env, 'main/a.md': '# A', 'ref/b.md': '# B', 'ref/.confluence-sync.json': '{"b.md":{"pageId":"123"}}' });
  const calls = [];
  const sync = createWebSync(async args => { calls.push(args); return 0; });
  const input = { ...request(join(root, 'main')), referenceRoots: [join(root, 'ref')] };
  await sync.preview(input); const { planId } = await finished(sync);
  assert.deepEqual(calls[0].slice(2,4), ['--reference-root', realpathSync(join(root,'ref'))]);
  put('ref/.confluence-sync.json', '{"b.md":{"pageId":"456"}}');
  await assert.rejects(sync.push(planId), /변경/); assert.equal(calls.length,1);
  await assert.rejects(sync.preview({...input,referenceRoots:'invalid'}), /참조/);
});

test('remote scope metadata changes invalidate web preview and verify is shared with CLI', async t => {
 const {root,put}=workspace(t,{'.env':env,'a.md':'# A','b.md':'# B'});
 const calls=[];const sync=createWebSync(async args=>{calls.push(args);return 0;});
 const input=request(root);await sync.preview({...input,verify:true});const preview=await finished(sync);
 assert.ok(calls[0].includes('--verify'));assert.ok(calls[0].includes('--dry-run'));
 const config=JSON.parse(readFileSync(join(root,'.csync/workspace.json'),'utf8'));config.scope.path='/Changed';
 put('.csync/workspace.json',JSON.stringify(config));
 await assert.rejects(sync.push(preview.planId),/변경/);
});

test('web requires explicit scope selection and exposes no inferred scope from the env parent',async t=>{
 const {root}=workspace(t,{'.env':env,'doc.md':'# Doc'});const sync=createWebSync(async()=>0);
 assert.equal((await sync.config(root,'')).scope,null);
 await assert.rejects(sync.preview({base:root,target:'',envFile:'',verify:false}),/스코프가 설정되지/);
 await assert.rejects(sync.setScope({base:root,envFile:'',scopeId:''}),/직접 선택/);
 assert.equal(existsSync(join(root,'.csync')),false);
});

test('scope HTTP endpoints require the local token before accepting any remote tree request',async t=>{
 const {root}=workspace(t,{'.env':env,'doc.md':'# Doc'});const {server,url}=await startWeb({start:root,port:0});
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 for(const path of ['/api/sync/scopes','/api/sync/scope']) {
  const response=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({base:root,envFile:'',scopeId:'123'})});
  assert.equal(response.status,403);
 }
});

test('web scope selection uses the same metadata-only configuration and invalidates an approved preview',async t=>{
 const {root}=workspace(t,{'.env':env,'doc.md':'# Doc'});const sync=createWebSync(async()=>0);
 const space={path:'/wiki/api/v2/spaces?keys=TEST',body:{results:[{id:'space',homepageId:'100'}]}};
 const rootInfo={path:'/wiki/rest/api/content/100?expand=ancestors,space,version',body:{id:'100',title:'Home',type:'page',space:{id:'space'},ancestors:[]}};
 const selectedInfo={path:'/wiki/rest/api/content/200?expand=ancestors,space,version',body:{id:'200',title:'Patents',type:'folder',space:{id:'space'},ancestors:[{id:'100',title:'Home'}]}};
 const calls=mockFetch(t,[space,rootInfo,{path:'/wiki/rest/api/content/100/child/folder?limit=100',body:{results:[{id:'200',title:'Patents'}]}},{path:'/wiki/rest/api/content/100/child/page?limit=100',body:{results:[]}},space,selectedInfo,space,selectedInfo]);
 const tree=await sync.scopes({base:root,envFile:''});assert.equal(tree.children[0].id,'200');assert.equal((await sync.config(root,'')).scope,null);
 const config=await sync.setScope({base:root,envFile:'',scopeId:'200'});assert.equal(config.scope.id,'200');
 const input={base:root,target:'',envFile:'',verify:false};await sync.preview(input);const preview=await finished(sync);assert.ok(preview.planId);
 await sync.setScope({base:root,envFile:'',scopeId:'200'});await assert.rejects(sync.push(preview.planId),/미리보기/);
 assert.ok(calls.every(call=>(call.method??'GET')==='GET'));assert.equal(existsSync(mappingPath(root)),false);
});
