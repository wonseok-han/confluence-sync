import test from 'node:test';
import { get } from 'node:http';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, symlinkSync, statSync } from 'node:fs';
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
  assert.match(data.after, /\.\.\/참조\.md/); assert.match(data.after, /attachments\/files\//);
  assert.equal(data.output, null); assert.deepEqual(readdirSync(root), ['vault']);
  assert.equal(readFileSync(body.file, 'utf8'), original);
  response = await post({ ...body, preview: false }); assert.equal(response.status, 200);
  data = await response.json();
  assert.equal(readFileSync(join(data.output, '가이드/문서.md'), 'utf8'), data.after);
  assert.equal(existsSync(join(data.output, '참조.md')), false);
  const hashes = readdirSync(join(data.output, 'attachments/files'));
  assert.equal(readFileSync(join(data.output, 'attachments/files', hashes[0], 'image.png'), 'utf8'), 'image-data');
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
  assert.equal(response.status, 200); assert.ok((await response.json()).path.endsWith('/문서'));
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
  const data = await response.json(); assert.ok(data.output.endsWith('/new/nested'));
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
  for (const out of [root, join(root, 'vault'), join(root, 'vault/new'), join(root, 'alias/new')]) {
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
  for (const file of ['app.js', 'app.css', 'editor.worker.js']) {
    const response = await fetch(url + '/assets/' + file);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 1000);
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

test('consecutive exports reuse shared attachments and remain usable after a conflict', async t => {
  const { root, put } = workspace(t, { 'vault/a.md': '# A\n\n![image](image.png)', 'vault/b.md': '# B\n\n![image](image.png)', 'vault/image.png': 'shared-image' });
  const { post } = await app(t, root);
  const body = { base: join(root, 'vault'), file: join(root, 'vault/a.md'), out: join(root, 'output'), to: 'markdown', fix: false, preview: false };
  for (const name of ['a.md', 'a.md', 'b.md']) {
    const response = await post({ ...body, file: join(root, 'vault', name) });
    assert.equal(response.status, 200); await response.json();
  }
  assert.ok(existsSync(join(root, 'output/a.md')));
  assert.ok(existsSync(join(root, 'output/b.md')));
  assert.equal(readdirSync(join(root, 'output/attachments/files')).length, 1);
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
