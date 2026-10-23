import {mappingPath, workspacePath} from '../dist/sync/metadata.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { workspace, mockFetch, configure } from './helpers/fixtures.mjs';
import { runPull } from '../dist/sync/pull.js';
import { buildTreeRenderer } from '../dist/sync/render.js';
import { docHash } from '../dist/documents/markdown.js';
import { collectMarkdown } from '../dist/documents/catalog.js';
import { loadWorkspace, scopePath } from '../dist/sync/workspace.js';

const cli = resolve('dist/sync.js');
const preload = pathToFileURL(resolve('tests/helpers/fetch-preload.mjs')).href;
const mapFile = '.confluence-sync.json', configFile = '.confluence-workspace.json';
const space = { path: '/wiki/api/v2/spaces?keys=TEST', body: { results: [{ id: 'space', homepageId: '100' }] } };
const page = id => `/wiki/api/v2/pages/${id}`;
const remote = (id, title, body = '<p>Remote</p>', number = 1, type = 'page') => ({
 path: `/wiki/rest/api/content/${id}?expand=body.export_view,body.storage,version`,
 body: { id, title, type, body: { export_view: { value: body }, storage: { value: body } }, version: { number } },
});
const children = (id, pages = [], folders = []) => [
 { path: `/wiki/rest/api/content/${id}/child/folder?limit=100`, body: { results: folders } },
 { path: `/wiki/rest/api/content/${id}/child/page?limit=100`, body: { results: pages } },
];
const load = (root, path = mapFile) => JSON.parse(readFileSync(path === mapFile ? mappingPath(root) : path === configFile ? workspacePath(root) : join(root, path), 'utf8'));
function baseline(root, entries) {
 const rels = collectMarkdown(root).map(path => path.slice(root.length + 1).split('\\').join('/'));
 const tree = buildTreeRenderer(root, rels);
 const mapping = {};
 for (const [rel, id] of Object.entries(entries)) {
  if (rel.endsWith('/')) { mapping[rel] = { pageId: id, type: 'folder' }; continue; }
  const doc = tree.docs[rel];
  mapping[rel] = { pageId: id, title: doc.title, hash: docHash(doc.title, tree.render(rel, doc.body, doc.title)), remoteVersion: 1 };
 }
 writeFileSync(join(root, mapFile), JSON.stringify(mapping));
 return mapping;
}
function run(root, args, extra = {}) {
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CONFLUENCE_')));
 return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env: { ...env, NO_COLOR: '1', ...extra } });
}
function offline(root, put, args, steps) {
 const responses = put('responses.json', JSON.stringify(steps)), calls = put('calls.jsonl', '');
 const result = run(root, args, {
  NODE_OPTIONS: `--import=${preload}`, CSYNC_TEST_RESPONSES: responses, CSYNC_TEST_CALLS: calls,
  CONFLUENCE_BASE_URL: 'https://example.invalid/wiki', CONFLUENCE_EMAIL: 'test@example.invalid', CONFLUENCE_API_TOKEN: 'fake', CONFLUENCE_SPACE_KEY: 'TEST',
 });
 return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
}

test('init stores repeatable relative scopes without touching credentials or contacting Confluence', t => {
 const { root, put } = workspace(t, { '.env': 'keep-original' });
 const result = offline(root, put, ['init', '--scope', 'patents', '--scope', 'notes'], []);
 assert.equal(result.status, 0, result.stderr);
 assert.deepEqual(loadWorkspace(root).syncPaths, ['patents', 'notes']);
 assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'keep-original');
 assert.equal(offline(root, put, ['init', '--scope', '../outside'], []).status, 1);
 assert.deepEqual(loadWorkspace(root).syncPaths, ['patents', 'notes']);
});

test('saved scope publishes only its new child and leaves changed ancestor and unrelated mapping untouched', t => {
 const { root, put } = workspace(t, { 'area/README.md': '# Area', 'area/patents/README.md': '# Patents', 'other.md': '# Other' });
 const before = baseline(root, { 'area/README.md': '10', 'area/patents/README.md': '20', 'other.md': '30' });
 put('area/README.md', '# Area\n\nUnselected edit'); put('other.md', '# Other\n\nUnselected edit'); put('area/patents/new.md', '# New');
 put(configFile, JSON.stringify({ version: 1, syncPaths: ['area/patents'] }));
 const result = offline(root, put, ['sync', '--base', root], [space, { path: '/wiki/api/v2/pages', method: 'POST', body: { id: '40', version: { number: 1 } } }]);
 assert.equal(result.status, 0, result.stderr); assert.equal(result.calls.at(-1).body.parentId, '20');
 assert.deepEqual(load(root)['area/README.md'], before['area/README.md']); assert.deepEqual(load(root)['other.md'], before['other.md']);
});

for (const args of [['other.md'], ['--rebuild']]) test(`scope expansion is rejected before any network ${args}`, t => {
 const { root, put } = workspace(t, { 'patents/doc.md': '# Doc', 'other.md': '# Other', [configFile]: JSON.stringify({ version: 1, syncPaths: ['patents'] }) });
 assert.equal(offline(root, put, ['--base', root, ...args], []).status, 1);
});

test('a saved scope cannot create an unconnected ancestor outside its boundary', t => {
 const { root, put } = workspace(t, { 'area/patents/doc.md': '# Doc', [configFile]: JSON.stringify({ version: 1, syncPaths: ['area/patents'] }) });
 const result = offline(root, put, ['--base', root], []); assert.equal(result.status, 1); assert.match(result.stderr, /상위 폴더 연결이 없습니다/);
});

test('outer sync excludes independent nested mappings, even when force is requested', t => {
 const { root, put } = workspace(t, { 'doc.md': '# Doc', 'nested/private.md': '# Private', 'nested/.confluence-sync.json': '{}' });
 const result = offline(root, put, ['--base', root, '--dry-run', '--force'], []);
 assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /doc.md/); assert.doesNotMatch(result.stdout, /private.md/);
});

test('CLI discovers the nearest root and its .env when invoked inside a subfolder', t => {
 const { root, put } = workspace(t, { [mapFile]: '{}', '.env': 'CONFLUENCE_SPACE_KEY=TEST', 'doc.md': '# Doc', 'sub/keep.txt': '' });
 const result = run(join(root, 'sub'), ['--dry-run']); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /doc.md/);
 // An explicit base reads that base's .env rather than relying on cwd dotenv loading.
 const env = 'CONFLUENCE_BASE_URL=https://example.invalid/wiki\nCONFLUENCE_EMAIL=test@example.invalid\nCONFLUENCE_API_TOKEN=fake\nCONFLUENCE_SPACE_KEY=TEST';
 put('.env', env);
 const responses = put('responses.json', JSON.stringify([space, { path: '/wiki/api/v2/pages', method: 'POST', body: { id: '1' } }]));
 const calls = put('calls.jsonl', '');
 const pushed = run(join(root, 'sub'), ['--base', root], { NODE_OPTIONS: `--import=${preload}`, CSYNC_TEST_RESPONSES: responses, CSYNC_TEST_CALLS: calls });
 assert.equal(pushed.status, 0, pushed.stderr);
 assert.equal(load(root)['doc.md'].pageId, '1');
});

test('pull space binds the actual root; immediate push and new root documents never create a wrapper', async t => {
 configure(t); const { root, put } = workspace(t);
 mockFetch(t, [space, remote('100', 'Space Home'), ...children('100', [{ id: '101', title: 'Child' }]), remote('101', 'Child'), ...children('101')]);
 await runPull(['pull', '--space', '--out', root]);
 assert.ok(existsSync(join(root, 'README.md'))); assert.ok(existsSync(join(root, 'Child.md'))); assert.equal(existsSync(join(root, 'Space Home')), false);
 assert.equal(load(root)['README.md'].remoteVersion, 1); assert.equal(load(root, configFile).root.id, '100');
 let result = offline(root, put, ['--base', root], [space]); assert.equal(result.status, 0, result.stderr);
 put('New.md', '# New'); result = offline(root, put, ['--base', root], [space, { path: '/wiki/api/v2/pages', method: 'POST', body: { id: '102' } }]);
 assert.equal(result.status, 0, result.stderr); assert.equal(result.calls.at(-1).body.parentId, '100');
});

test('push preflights all existing changes before creating any new page or folder', t => {
 const { root, put } = workspace(t, { 'z.md': '# Z' }); baseline(root, { 'z.md': '1' }); put('z.md', '# Z\n\nLocal edit'); put('a.md', '# New');
 const before = readFileSync(join(root, mapFile), 'utf8');
 const result = offline(root, put, ['--base', root], [space, { path: page('1'), body: { spaceId: 'space', version: { number: 2 } } }]);
 assert.equal(result.status, 1); assert.match(result.stderr, /원격 변경 충돌/); assert.ok(result.calls.every(call => call.method === 'GET')); assert.equal(readFileSync(join(root, mapFile), 'utf8'), before);
});

test('remote changes after preflight are rechecked immediately before a page write', t => {
 const { root, put } = workspace(t, { 'doc.md': '# Doc' }); baseline(root, { 'doc.md': '1' }); put('doc.md', '# Doc\n\nEdit');
 const result = offline(root, put, ['--base', root], [space, { path: page('1'), body: { version: { number: 1 } } }, { path: page('1'), body: { version: { number: 2 } } }]);
 assert.equal(result.status, 1); assert.ok(result.calls.every(call => call.method === 'GET')); assert.equal(load(root)['doc.md'].remoteVersion, 1);
});

test('dry-run verify checks remote versions without changing documents, mapping or workspace settings', t => {
 const { root, put } = workspace(t, { 'doc.md': '# Doc' }); baseline(root, { 'doc.md': '1' });
 const before = readFileSync(join(root, mapFile), 'utf8');
 const result = offline(root, put, ['--base', root, '--dry-run', '--verify'], [space, { path: page('1'), body: { version: { number: 1 } } }]);
 assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(join(root, mapFile), 'utf8'), before); assert.equal(existsSync(workspacePath(root)), false);
});

test('pull refuses local edits after staging and preserves every existing source and baseline', async t => {
 configure(t); const { root, put } = workspace(t, { 'Doc.md': '# Doc' }); baseline(root, { 'Doc.md': '1' });
 put('Doc.md', '# Doc\n\nLocal edit'); const before = readFileSync(join(root, mapFile), 'utf8');
 mockFetch(t, [remote('1', 'Doc', '<p>Remote edit</p>', 2)]);
 await assert.rejects(runPull(['pull', '1', '--out', root]), /로컬 변경 충돌/);
 assert.match(readFileSync(join(root, 'Doc.md'), 'utf8'), /Local edit/); assert.equal(readFileSync(join(root, mapFile), 'utf8'), before);
});

test('pull updates a clean mapped file in place despite remote rename and advances its version', async t => {
 configure(t); const { root } = workspace(t, { 'Original.md': '# Original' }); baseline(root, { 'Original.md': '1' });
 mockFetch(t, [remote('1', 'Renamed', '<p>Remote edit</p>', 2)]);
 await runPull(['pull', '1', '--out', root]); assert.match(readFileSync(join(root, 'Original.md'), 'utf8'), /Remote edit/); assert.equal(existsSync(join(root, 'Renamed.md')), false); assert.equal(load(root)['Original.md'].remoteVersion, 2);
});

test('a failed descendant download leaves the entire existing workspace unchanged', async t => {
 configure(t); const { root } = workspace(t, { 'README.md': '# Home' }); baseline(root, { 'README.md': '100' });
 const before = readFileSync(join(root, 'README.md'), 'utf8');
 mockFetch(t, [space, remote('100', 'Home', '<p>New remote</p>', 2), ...children('100', [{ id: '101', title: 'Child' }]), { ...remote('101', 'Child'), status: 403 }]);
 await assert.rejects(runPull(['pull', '--space', '--out', root]), /403/); assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), before); assert.equal(load(root)['README.md'].remoteVersion, 1); assert.equal(existsSync(workspacePath(root)), false);
});

test('pull filename collisions fail before any staged content is applied', async t => {
 configure(t); const { root } = workspace(t);
 mockFetch(t, [space, remote('100', 'Home'), ...children('100', [{ id: '101', title: 'A/B' }, { id: '102', title: 'A:B' }]), remote('101', 'A/B'), ...children('101'), remote('102', 'A:B'), ...children('102')]);
 await assert.rejects(runPull(['pull', '--space', '--out', root]), /같은 로컬 경로/); assert.equal(existsSync(join(root, 'README.md')), false); assert.equal(existsSync(join(root, mapFile)), false);
});

test('pull without a target uses the saved subtree and never queries unrelated roots', async t => {
 configure(t); const { root } = workspace(t, { 'patents/README.md': '# Patents', 'Other.md': '# Other', [configFile]: JSON.stringify({ version: 1, syncPaths: ['patents'] }) });
 const before = baseline(root, { 'patents/README.md': '10', 'Other.md': '20' });
 mockFetch(t, [remote('10', 'Patents', '<p>Updated</p>', 2), ...children('10', [{ id: '11', title: 'New' }]), remote('11', 'New'), ...children('11')]);
 await runPull(['pull', '--base', root]); assert.ok(existsSync(join(root, 'patents/New.md'))); assert.deepEqual(load(root)['Other.md'], before['Other.md']); assert.equal(readFileSync(join(root, 'Other.md'), 'utf8'), '# Other');
});

test('scoped pull rejects whole-space requests and outside page IDs before any network', async t => {
 configure(t); const { root } = workspace(t, { [configFile]: JSON.stringify({ version: 1, syncPaths: ['patents'] }) });
 mockFetch(t, []); await assert.rejects(runPull(['pull', '--space', '--base', root]), /관리 범위/); await assert.rejects(runPull(['pull', '999', '--base', root]), /관리 범위/);
});

test('scope paths and persisted configuration cannot escape through traversal or symlinks', t => {
 const { root, put } = workspace(t); const outside = workspace(t); symlinkSync(outside.root, join(root, 'alias'), 'junction');
 assert.throws(() => scopePath(root, 'alias'), /작업공간 밖/);
 put(configFile, JSON.stringify({ version: 1, syncPaths: ['patents/../other'] })); assert.throws(() => loadWorkspace(root), /정규화/);
});

test('corrupt mappings fail closed instead of recreating pages', t => {
 const { root, put } = workspace(t, { 'doc.md': '# Doc', [mapFile]: '{broken' });
 const result = offline(root, put, ['--base', root], []); assert.equal(result.status, 1); assert.match(result.stderr, /매핑/);
});

test('pull replaces remotely changed attachments only when the owning local document and bytes are clean', async t => {
 configure(t); const { root, put } = workspace(t);
 const node = number => remote('1', 'Doc', '<p>Remote</p><img src="/download/attachments/1/image.png"/>', number);
 const attachment = { path: '/wiki/rest/api/content/1/child/attachment?limit=100', body: { results: [{ title: 'image.png', _links: { download: '/download/image.png' } }] } };
 const steps = bytes => [attachment, { path: '/wiki/download/image.png', bytes: Buffer.from(bytes) }];
 const calls = mockFetch(t, [node(1), ...steps('first'), node(2), ...steps('second'), node(3), ...steps('third')]);
 await runPull(['pull', '1', '--out', root]);
 await runPull(['pull', '1', '--out', root]);
 assert.equal(readFileSync(join(root, 'attachments/Doc/image.png'), 'utf8'), 'second');
 assert.equal(load(root)['Doc.md'].remoteVersion, 2);
 put('attachments/Doc/image.png', 'local edit');
 await assert.rejects(runPull(['pull', '1', '--out', root]), /로컬 변경 충돌|첨부 파일 충돌/);
 assert.equal(readFileSync(join(root, 'attachments/Doc/image.png'), 'utf8'), 'local edit');
 assert.equal(load(root)['Doc.md'].remoteVersion, 2); assert.equal(calls.length, 9);
});

test('first pull can create a previously absent output directory and bind a subtree root', async t => {
 configure(t); const { root } = workspace(t); const output = join(root, 'new-docs');
 mockFetch(t, [remote('1', 'Subtree'), ...children('1')]);
 await runPull(['pull', '1', '--root', '--out', output]);
 assert.ok(existsSync(join(output, 'README.md'))); assert.equal(load(output, configFile).root.id, '1');
});

test('existing files with no baseline are never overwritten by pull', async t => {
 configure(t); const { root } = workspace(t, { 'Doc.md': '# Untracked notes' });
 mockFetch(t, [remote('1', 'Doc')]);
 await assert.rejects(runPull(['pull', '1', '--out', root]), /로컬 변경 충돌/);
 assert.equal(readFileSync(join(root, 'Doc.md'), 'utf8'), '# Untracked notes'); assert.equal(existsSync(join(root, mapFile)), false);
});

test('connection changes are refused before querying a different Confluence site', t => {
 const { root, put } = workspace(t, { 'doc.md': '# Doc', [configFile]: JSON.stringify({ version: 1, connection: { baseUrl: 'https://other.invalid/wiki', spaceKey: 'TEST' } }) });
 const result = offline(root, put, ['--base', root], []); assert.equal(result.status, 1); assert.match(result.stderr, /사이트·스페이스/);
});

test('pull materializes empty remote folders as local directories', async t => {
 configure(t); const {root}=workspace(t);
 mockFetch(t,[space,remote('100','Home'),...children('100',[],[{id:'200',title:'Empty'}]),remote('200','Empty','',1,'folder'),...children('200')]);
 await runPull(['pull','--space','--out',root]);
 assert.ok(existsSync(join(root,'Empty')));assert.equal(load(root)['Empty/'].pageId,'200');
});

test('init does not silently adopt an existing nested workspace as an outer scope',t=>{
 const {root,put}=workspace(t,{'nested/doc.md':'# Doc','nested/.confluence-sync.json':'{}'});
 const result=offline(root,put,['init','--scope','nested'],[]);
 assert.equal(result.status,1);assert.match(result.stderr,/독립된 하위 작업공간/);assert.equal(existsSync(join(root,configFile)),false);
});
