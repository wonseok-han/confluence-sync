import test from 'node:test';
import { get } from 'node:http';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, symlinkSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { startWeb } from '../dist/web/server.js';
import { workspace } from './helpers/fixtures.mjs';

async function app(t, start, options = {}) {
  const { server, url } = await startWeb({ start, port: 0, ...options });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const html = await (await fetch(url)).text();
  const token = html.match(/name="csync-token" content="([^"]+)"/)[1];
  const headers = { 'X-Csync-Token': token, 'Content-Type': 'application/json' };
  const post = body => fetch(url + '/api/convert', { method: 'POST', headers, body: JSON.stringify(body) });
  return { url, headers, post };
}

test('web browses Korean paths and protects local APIs from foreign origins and hosts', async t => {
  const { root } = workspace(t, { '문서/안내.md': '# 안내', '.secret.md': 'hidden', 'asset.png': 'asset', 'node_modules/test.md': '# hidden' });
  const { url, headers } = await app(t, root);
  assert.equal((await fetch(url + '/api/browse')).status, 403);
  assert.equal((await fetch(url + '/api/browse', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    get(url, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  const listing = await (await fetch(url + '/api/browse', { headers })).json();
  assert.deepEqual(listing.entries.map(e => e.name), ['문서']);
  const nested = await (await fetch(url + '/api/browse?path=' + encodeURIComponent(join(root, '문서')), { headers })).json();
  assert.equal(nested.entries[0].name, '안내.md');
});

test('web previews and exports one document with attachments, preserving originals and cleaning temporary output', async t => {
  const original = '# 안내\n\n[[참조]]\n\n![첨부](image.png)\n';
  const { root } = workspace(t, { 'vault/가이드/문서.md': original, 'vault/참조.md': '# 참조', 'vault/가이드/image.png': 'image-data' });
  const { post } = await app(t, root);
  const body = { base: join(root, 'vault'), file: join(root, 'vault/가이드/문서.md'), to: 'markdown', fix: false, preview: true };
  let response = await post(body); assert.equal(response.status, 200);
  let data = await response.json();
  assert.match(data.after, /\.\.\/참조\.md/); assert.match(data.after, /attachments\/문서\//);
  assert.equal(data.output, null); assert.deepEqual(readdirSync(root), ['vault']);
  assert.equal(readFileSync(body.file, 'utf8'), original);
  response = await post({ ...body, preview: false }); assert.equal(response.status, 200);
  data = await response.json();
  assert.equal(readFileSync(join(data.output, '가이드/문서.md'), 'utf8'), data.after);
  assert.equal(existsSync(join(data.output, '참조.md')), false);
  assert.equal(readFileSync(join(data.output, '가이드/attachments/문서/image.png'), 'utf8'), 'image-data');
  assert.equal(readFileSync(body.file, 'utf8'), original);
  const second = await (await post({ ...body, preview: false })).json();
  assert.notEqual(data.output, second.output);
});

test('web handles Obsidian and repair-only conversion and rejects invalid or escaped selections', async t => {
  const { root } = workspace(t, { 'vault/a.md': '# A\n\n[B](b.md)\n', 'vault/b.md': '# B', 'outside.md': '# Outside', 'vault/.hidden/a.md': '# Hidden' });
  const { post, url, headers } = await app(t, root);
  const body = { base: join(root, 'vault'), file: join(root, 'vault/a.md'), to: 'obsidian', fix: false, preview: true };
  assert.match((await (await post(body)).json()).after, /\[\[b\|B\]\]/);
  assert.equal((await post({ ...body, to: 'repair' })).status, 200);
  for (const changes of [{ file: join(root, 'outside.md') }, { to: 'bad' }, { file: join(root, 'missing.md') }, { file: join(root, 'vault/.hidden/a.md') }]) {
    assert.equal((await post({ ...body, ...changes })).status, 400);
  }
  symlinkSync(join(root, 'outside.md'), join(root, 'vault/escape.md'));
  assert.equal((await post({ ...body, file: join(root, 'vault/escape.md') })).status, 400);
  assert.equal((await fetch(url + '/api/convert', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(url + '/api/open', { method: 'POST', headers, body: JSON.stringify({ path: root }) })).status, 400);
});

test('conversion errors leave the server usable and remove partial output', async t => {
  const { root } = workspace(t, { 'vault/a.md': '# A\n\n![[missing.pdf#page=1]]' });
  const { post } = await app(t, root);
  const body = { base: join(root, 'vault'), file: join(root, 'vault/a.md'), to: 'markdown', fix: false, preview: false };
  const response = await post(body); assert.equal(response.status, 400);
  assert.match((await response.json()).error, /PDF/);
  assert.deepEqual(readdirSync(root), ['vault']);
  assert.equal((await post({ ...body, to: 'repair' })).status, 200);
});


test('web serializes concurrent conversion requests', async t => {
  const { root } = workspace(t, { 'vault/a.md': '# A' });
  const { post } = await app(t, root);
  const body = { base: join(root, 'vault'), file: join(root, 'vault/a.md'), to: 'markdown', fix: false, preview: true };
  const responses = await Promise.all([post(body), post(body)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(readdirSync(root), ['vault']);
});


test('folder dialog returns canonical paths, cancellation and errors without changing documents', async t => {
  const { root } = workspace(t, { '문서/a.md': '# A' });
  const calls = [];
  let selected = join(root, '문서');
  const { url, headers } = await app(t, root, { pickFolder: async (start, title) => { calls.push({ start, title }); return selected; } });
  const pick = body => fetch(url + '/api/pick-folder', { method: 'POST', headers, body: JSON.stringify(body) });
  let response = await pick({ kind: 'base', start: root });
  assert.equal(response.status, 200); assert.equal((await response.json()).path, await realpath(selected));
  assert.match(calls[0].title, /기준/);
  selected = null;
  assert.deepEqual(await (await pick({ kind: 'out' })).json(), { path: null });
  assert.match(calls[1].title, /출력/);
  assert.equal((await pick({ kind: 'invalid' })).status, 400);
  assert.equal(readFileSync(join(root, '문서/a.md'), 'utf8'), '# A');
});

test('explicit output supports a new path or existing directory and never writes on preview', async t => {
  const { root } = workspace(t, { 'vault/a.md': '# A\n\n[[b]]', 'vault/b.md': '# B', 'output/keep.txt': 'keep' });
  const { post } = await app(t, root);
  const body = { base: join(root, 'vault'), file: join(root, 'vault/a.md'), to: 'markdown', fix: false, preview: true, out: join(root, 'new/nested') };
  assert.equal((await post(body)).status, 200);
  assert.equal(existsSync(join(root, 'new')), false);
  let response = await post({ ...body, preview: false }); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.output, await realpath(body.out));
  assert.match(readFileSync(join(root, 'new/nested/a.md'), 'utf8'), /b\.md/);
  response = await post({ ...body, out: join(root, 'output'), preview: false }); assert.equal(response.status, 200);
  assert.equal(readFileSync(join(root, 'output/keep.txt'), 'utf8'), 'keep');
  const saved = readFileSync(join(root, 'output/a.md'), 'utf8');
  response = await post({ ...body, out: join(root, 'output'), preview: false }); assert.equal(response.status, 200);
  response = await post({ ...body, to: 'obsidian', out: join(root, 'output'), preview: false }); assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'OVERWRITE_REQUIRED');
  assert.equal(readFileSync(join(root, 'output/a.md'), 'utf8'), saved);
});

test('output rejects source overlap, alias overlap and nested destination symlinks', async t => {
  const { root } = workspace(t, { 'vault/sub/a.md': '# A', 'elsewhere/keep.md': '# Keep', 'output/.keep': '' });
  const { post } = await app(t, root);
  const body = { base: join(root, 'vault'), file: join(root, 'vault/sub/a.md'), to: 'markdown', fix: false, preview: false };
  symlinkSync(join(root, 'vault'), join(root, 'alias'), 'junction');
  for (const out of [root, join(root, 'vault/new'), join(root, 'alias/new')]) {
    assert.equal((await post({ ...body, out })).status, 400);
  }
  symlinkSync(join(root, 'elsewhere'), join(root, 'output/sub'), 'junction');
  assert.equal((await post({ ...body, out: join(root, 'output') })).status, 400);
  assert.equal(existsSync(join(root, 'elsewhere/a.md')), false);
  assert.equal(readFileSync(body.file, 'utf8'), '# A');
});

test('bundled Monaco assets and worker are available locally without an API token', async t => {
  const { root } = workspace(t);
  const { url } = await app(t, root);
  const chunks = readdirSync(new URL('../dist/web/assets/chunks/', import.meta.url)).filter(file => /\.(js|css)$/.test(file)).map(file => 'chunks/' + file);
  for (const file of ['app.js', 'app.css', 'editor.worker.js', ...chunks]) {
    const response = await fetch(url + '/assets/' + file);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), file.endsWith('.js') ? /javascript/ : /css/);
    assert.ok((await response.text()).length > 0);
  }
  const response = await fetch(url + '/assets/..%2f..%2fpackage.json');
  assert.notEqual(response.status, 200);
});

test('recursive filename search finds deepest documents, normalizes Korean and stays in the selected tree', async t => {
  const { root } = workspace(t, {
    'vault/안내.md': '# Root', 'vault/a/b/c/안내.MD': '# Deep',
    'vault/other/안내.md': '# Other', 'vault/a/가이드.md': '# Guide',
    'vault/.hidden/안내.md': '# Hidden', 'vault/node_modules/안내.md': '# Hidden',
    'vault/안내.txt': 'not markdown', 'outside/안내.md': '# Outside',
  });
  symlinkSync(join(root, 'outside'), join(root, 'vault/linked'), 'junction');
  symlinkSync(join(root, 'vault'), join(root, 'vault/loop'), 'junction');
  const { url, headers, post } = await app(t, root);
  const search = async (path, q) => {
    const response = await fetch(url + '/api/search?' + new URLSearchParams({ path, q }), { headers });
    assert.equal(response.status, 200); return response.json();
  };
  const found = await search(join(root, 'vault'), '안내'.normalize('NFD'));
  assert.equal(found.entries.length, 3);
  assert.ok(found.entries.some(e => e.relativePath === join('a', 'b', 'c', '안내.MD')));
  assert.equal((await search(join(root, 'vault/a'), '안내')).entries.length, 1);
  assert.equal((await search(join(root, 'vault'), 'no-match')).entries.length, 0);
  assert.equal((await search(join(root, 'vault'), ' ')).entries.length, 0);
  assert.equal((await search(join(root, 'vault'), '.md')).entries.length, 4);
  assert.equal((await fetch(url + '/api/search?q=안내')).status, 403);
  const deep = found.entries.find(e => e.name === '안내.MD');
  assert.equal((await post({ base: found.root, file: deep.path, to: 'markdown', fix: false, preview: true })).status, 200);
});

test('consecutive exports reuse document attachments and remain usable after a conflict', async t => {
  const { root, put } = workspace(t, { 'vault/a.md': '# A\n\n![image](image.png)', 'vault/b.md': '# B\n\n![image](image.png)', 'vault/image.png': 'shared-image' });
  const { post } = await app(t, root);
  const body = { base: join(root, 'vault'), file: join(root, 'vault/a.md'), out: join(root, 'output'), to: 'markdown', fix: false, preview: false };
  for (const name of ['a.md', 'a.md', 'b.md']) {
    const response = await post({ ...body, file: join(root, 'vault', name) });
    assert.equal(response.status, 200); await response.json();
  }
  assert.ok(existsSync(join(root, 'output/a.md')));
  assert.ok(existsSync(join(root, 'output/b.md')));
  assert.deepEqual(readdirSync(join(root, 'output/attachments')).sort(), ['a','b']);
  assert.equal(readFileSync(join(root,'output/attachments/a/image.png'),'utf8'),'shared-image');
  assert.equal(readFileSync(join(root,'output/attachments/b/image.png'),'utf8'),'shared-image');
  put('vault/a.md', '# Changed');
  assert.equal((await post(body)).status, 409);
  assert.match(readFileSync(join(root, 'output/a.md'), 'utf8'), /# A/);
  assert.equal((await post({ ...body, preview: true })).status, 200);
  assert.equal((await post({ ...body, out: '' })).status, 200);
});

test('explicit file conversion writes directly to output and folder conversion preserves only selected subtree', async t => {
  const { root } = workspace(t, { 'vault/project/nested/a.md': '# A\n\n[[b]]\n\n![image](image.png)', 'vault/project/nested/b.md': '# B', 'vault/project/nested/image.png': 'image', 'vault/outside.md': '# Outside' });
  const { post } = await app(t, root);
  const body = { base: join(root, 'vault'), file: join(root, 'vault/project/nested/a.md'), scope: 'file', out: join(root, 'single'), to: 'markdown', fix: false, preview: false };
  let response = await post(body); assert.equal(response.status, 200);
  let result = await response.json(); assert.equal(result.documentCount, 1);
  assert.ok(existsSync(join(root, 'single/a.md'))); assert.equal(existsSync(join(root, 'single/project')), false);
  assert.equal(existsSync(join(root, 'single/b.md')), false);
  const folder = { ...body, scope: 'folder', file: join(root, 'vault/project'), out: join(root, 'batch') };
  response = await post({ ...folder, preview: true }); assert.equal(response.status, 200);
  result = await response.json(); assert.equal(result.documentCount, 2); assert.equal(result.previews.length, 2);
  assert.equal(existsSync(join(root, 'batch')), false);
  response = await post(folder); assert.equal(response.status, 200); await response.json();
  assert.ok(existsSync(join(root, 'batch/nested/a.md'))); assert.ok(existsSync(join(root, 'batch/nested/b.md')));
  assert.equal(existsSync(join(root, 'batch/project')), false); assert.equal(existsSync(join(root, 'batch/outside.md')), false);
  assert.match(readFileSync(join(root, 'batch/nested/a.md'), 'utf8'), /b.md/);
  assert.equal((await post({ ...folder, out: join(root, 'vault/project/output') })).status, 400);
  assert.equal((await post({ ...body, scope: 'folder' })).status, 400);
  assert.equal((await post({ ...folder, scope: 'file' })).status, 400);
});

test('overwrite requires confirmation, rejects stale approval, and preserves unrelated files', async t => {
  const { root, put } = workspace(t, { 'vault/a.md': '# New', 'vault/b.md': '# Added', 'out/a.md': '# Old', 'out/keep.txt': 'keep' });
  const { post } = await app(t, root);
  const body = { base: join(root, 'vault'), file: join(root, 'vault'), scope: 'folder', out: join(root, 'out'), to: 'markdown', fix: false, preview: false };
  let response = await post(body); assert.equal(response.status, 409);
  let result = await response.json(); assert.equal(result.code, 'OVERWRITE_REQUIRED');
  assert.deepEqual(result.conflicts.map(c => c.path), ['a.md']);
  assert.equal(readFileSync(join(root,'out/a.md'),'utf8'),'# Old');
  assert.equal(existsSync(join(root,'out/b.md')),false);
  const approvedOverwrites = Object.fromEntries(result.conflicts.map(c=>[c.path,c.hash]));
  put('out/a.md','# Edited while confirming');
  response = await post({...body,approvedOverwrites});assert.equal(response.status,409);
  result = await response.json();assert.notEqual(result.conflicts[0].hash,approvedOverwrites['a.md']);
  response = await post({...body,approvedOverwrites:Object.fromEntries(result.conflicts.map(c=>[c.path,c.hash]))});
  assert.equal(response.status,200);await response.json();
  assert.equal(readFileSync(join(root,'out/a.md'),'utf8'),'# New');
  assert.equal(readFileSync(join(root,'out/b.md'),'utf8'),'# Added');
  assert.equal(readFileSync(join(root,'out/keep.txt'),'utf8'),'keep');
  const beforeRepeat = statSync(join(root,'out/a.md')).mtimeMs;
  const repeated = await (await post(body)).json();
  assert.deepEqual(repeated.saved, { created: 0, overwritten: 0, reused: 2 });
  assert.equal(statSync(join(root,'out/a.md')).mtimeMs, beforeRepeat);
  assert.deepEqual(readdirSync(join(root,'out')).sort(),['a.md','b.md','keep.txt']);
  assert.equal(readFileSync(join(root,'vault/a.md'),'utf8'),'# New');
  assert.equal((await post({...body,approvedOverwrites:true})).status,400);
});

test('localhost supports page, assets and same-origin API while rejecting foreign hosts and origins', async t => {
  const { root } = workspace(t, { 'a.md': '# A' });
  const { url, headers } = await app(t, root);
  const local = url.replace('127.0.0.1', 'localhost');
  assert.equal((await fetch(local)).status, 200);
  assert.equal((await fetch(local + '/assets/app.js')).status, 200);
  assert.equal((await fetch(local + '/api/browse', { headers: { ...headers, Origin: local } })).status, 200);
  assert.equal((await fetch(local + '/api/browse', { headers: { ...headers, Origin: url } })).status, 403);
  assert.equal((await fetch(local + '/api/browse', { headers: { ...headers, Origin: 'http://localhost:1' } })).status, 403);
  assert.equal((await fetch(local + '/api/browse')).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    get(url, { headers: { Host: 'localhost.evil.example:' + new URL(url).port } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(badHost,403);
});

test('web token guide serves only the annotated screenshots bundled with the package', async t => {
  const { root } = workspace(t, {}), { url } = await app(t, root);
  const html = await (await fetch(url)).text();
  assert.match(html, /id="open-token-guide"/);
  assert.match(html, /id="help-token"/);
  const images = [...html.matchAll(/<img src="(\/assets\/guide\/[^\/"]+)"/g)].map(match => match[1]);
  assert.equal(images.length, 7);
  for (const image of images) {
    const response = await fetch(url + image);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, readFileSync(new URL('../docs/user/images/guide/' + image.split('/').at(-1), import.meta.url)));
  }
  assert.equal((await fetch(url + '/docs/user/images/guide/01-account-settings.png')).status, 403);
});

test('help usage screenshots are collapsed, lazy-loaded and available in local and static builds', async t => {
  const {root}=workspace(t,{}),{url}=await app(t,root),html=await(await fetch(url)).text();
  assert.match(html,/href="#help-screens"/);
  const gallery=html.split('<section id="help-screens">')[1].split('</section>')[0];
  assert.doesNotMatch(gallery,/<details[^>]*\bopen\b/);
  assert.equal([...gallery.matchAll(/loading="lazy"/g)].length,3);
  const images=[...gallery.matchAll(/<img src="([^\"]+)"/g)].map(match=>match[1]);assert.equal(images.length,3);
  for(const image of images){
    const response=await fetch(url+image);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
    const expected=readFileSync(new URL('../docs/user/images/web/'+image.split('/').at(-1),import.meta.url));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);assert.deepEqual(readFileSync(new URL('../dist/site'+image,import.meta.url)),expected);
  }
});

test('document explorer and recursive search hide attachment directories without blocking referenced images',async t=>{
 const {root}=workspace(t,{'doc.md':'![Image](attachments/doc/image.png)','attachments/doc/image.png':'image bytes','attachments/doc/internal.md':'# Asset','notes/doc.md':'# Document','notes/attachments/doc/internal.md':'# Asset','Attachments/hidden.md':'# Asset','attachments-notes/visible.md':'# Visible'});
 const {url,headers}=await app(t,root);
 const browse=async path=>(await (await fetch(url+'/api/browse?'+new URLSearchParams({path}),{headers})).json()).entries;
 assert.deepEqual((await browse(root)).map(item=>item.name),['attachments-notes','notes','doc.md']);
 assert.deepEqual((await browse(join(root,'notes'))).map(item=>item.name),['doc.md']);
 const result=await (await fetch(url+'/api/search?'+new URLSearchParams({path:root,q:'.md'}),{headers})).json();
 assert.deepEqual(result.entries.map(item=>item.relativePath).sort(),['attachments-notes/visible.md','doc.md','notes/doc.md']);
 const response=await fetch(url+'/api/document-preview',{method:'POST',headers,body:JSON.stringify({base:root,file:join(root,'doc.md')})});assert.equal(response.status,200);assert.match((await response.json()).html,/data:image\/png;base64,/);
});

for (const scope of ['folder-root', 'folder-sub', 'file']) {
  test(`in-place conversion requires approval and preserves selection paths: ${scope}`, async t => {
    const original = '# 한글\\_제목\n';
    const { root } = workspace(t, { 'vault/sub/a.md': original, 'vault/other.md': original });
    const base = join(root, 'vault'), file = scope === 'folder-root' ? base : join(base, scope === 'file' ? 'sub/a.md' : 'sub');
    const { post } = await app(t, root);
    const body = { base, file, scope: scope === 'file' ? 'file' : 'folder', out: base, to: 'repair', fix: false, preview: false };
    const preview = await post({ ...body, preview: true });
    assert.equal(preview.status, 200); assert.equal((await preview.json()).output, null);
    assert.equal(readFileSync(join(base, 'sub/a.md'), 'utf8'), original);
    const first = await post(body); assert.equal(first.status, 409);
    const pending = await first.json(); assert.equal(pending.code, 'OVERWRITE_REQUIRED'); assert.equal(pending.inPlace, true);
    assert.equal(pending.conflicts.length, scope === 'folder-root' ? 2 : 1);
    assert.equal(readFileSync(join(base, 'sub/a.md'), 'utf8'), original);
    const approvedOverwrites = Object.fromEntries(pending.conflicts.map(item => [item.path, item.hash]));
    const saved = await post({ ...body, approvedOverwrites }); assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
    assert.equal(readFileSync(join(base, 'sub/a.md'), 'utf8'), '# 한글_제목\n');
    assert.equal(readFileSync(join(base, 'other.md'), 'utf8'), scope === 'folder-root' ? '# 한글_제목\n' : original);
    assert.equal(existsSync(join(base, 'a.md')), false);
    assert.deepEqual(readdirSync(root), ['vault']);
    assert.equal(readdirSync(base).some(name => name.startsWith('.csync-backup-')), false);
  });
}

test('in-place approval becomes invalid when the source is edited or deleted', async t => {
  const { root, put } = workspace(t, { 'vault/a.md': '# 한글\\_제목' });
  const base = join(root, 'vault'); const { post } = await app(t, root);
  const body = { base, file: base, scope: 'folder', out: base, to: 'repair', fix: false, preview: false };
  const pending = await (await post(body)).json();
  const approvedOverwrites = Object.fromEntries(pending.conflicts.map(item => [item.path, item.hash]));
  put('vault/a.md', 'external edit');
  const changed = await post({ ...body, approvedOverwrites }); assert.equal(changed.status, 409);
  assert.equal((await changed.json()).code, 'SOURCE_CHANGED'); assert.equal(readFileSync(join(base, 'a.md'), 'utf8'), 'external edit');
  const { unlinkSync } = await import('node:fs'); unlinkSync(join(base, 'a.md')); put('vault/b.md', '# Keep');
  const deleted = await post({ ...body, approvedOverwrites }); assert.equal(deleted.status, 409);
  assert.equal((await deleted.json()).code, 'SOURCE_CHANGED'); assert.equal(existsSync(join(base, 'a.md')), false);
});

test('document formatting API reviews all tables without writing and saves only an unchanged source', async t => {
  const original='#   Heading\nText\n\n| A | Long |\n|---|---|\n| X | A much longer body |\n';
  const {root,put}=workspace(t,{'a.md':original});const {url,headers}=await app(t,root);
  const request=(route,body)=>fetch(url+route,{method:'POST',headers,body:JSON.stringify(body)});
  const doc=await(await request('/api/document-preview',{base:root,file:join(root,'a.md')})).json();
  const response=await request('/api/document-format/preview',{base:root,file:join(root,'a.md'),hash:doc.hash,basic:true,tables:'fit'});assert.equal(response.status,200);
  const plan=await response.json();assert.match(plan.after,/# Heading\n\nText/);assert.match(plan.after,/<table/);assert.equal(readFileSync(join(root,'a.md'),'utf8'),original);
  put('a.md','User edit');assert.equal((await request('/api/table-format/save',{planId:plan.planId})).status,400);assert.equal(readFileSync(join(root,'a.md'),'utf8'),'User edit');
});
