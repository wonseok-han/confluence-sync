import {bindScope,scopeFixture} from './helpers/scope.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, symlinkSync, utimesSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, mockFetch, configure } from './helpers/fixtures.mjs';
import { mappingPath, workspacePath, ignorePath, migrateMetadata, metadataFiles } from '../dist/sync/metadata.js';
import { loadMapping, saveMapping } from '../dist/sync/mapping.js';
import { loadWorkspace, saveWorkspace, findSyncBase, inNestedWorkspace } from '../dist/sync/workspace.js';
import { buildIgnorer } from '../dist/sync/ignore.js';
import { collectMarkdown } from '../dist/documents/catalog.js';
import { buildTreeRenderer } from '../dist/sync/render.js';
import { runPull } from '../dist/sync/pull.js';
import { createWebSync } from '../dist/web/sync.js';

const cli = resolve('dist/sync.js');
const env = 'CONFLUENCE_BASE_URL=https://example.invalid/wiki\nCONFLUENCE_EMAIL=test@example.invalid\nCONFLUENCE_API_TOKEN=fake\nCONFLUENCE_SPACE_KEY=TEST\n';
const mapping = { 'patents/doc.md': { pageId: '123', hash: 'unchanged', remoteVersion: 4, pendingMove: { parentKey: 'patents/' } } };
const config = { version: 1, syncPaths: ['patents'] };
const legacy = { '.confluence-sync.json': JSON.stringify(mapping), '.confluence-workspace.json': JSON.stringify(config), '.confluence-syncignore': 'drafts/\n' };
const run = (root, args) => {
 const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CONFLUENCE_')));
 return spawnSync(process.execPath, [cli, ...args], { cwd: root, env: cleanEnv, encoding: 'utf8' });
};
const finished = async sync => {
 for (let i = 0; i < 100; i++) {
  if (sync.current()?.state !== 'running') return sync.current();
  await new Promise(resolve => setTimeout(resolve, 10));
 }
 assert.fail('job still running');
};
const request = base => ({ base, target: '', envId: '', verify: false });

test('fresh metadata lives only in .csync and is never collected as Markdown or assets', t => {
 const { root, put } = workspace(t, { '.env': env, 'doc.md': '# Doc' });
 saveMapping(mappingPath(root), mapping); saveWorkspace(root, config); put('.csync/ignore', 'drafts/\n'); put('.csync/private.md', '# State');
 assert.deepEqual(loadMapping(join(root, '.csync/mapping.json')), mapping);
 assert.deepEqual(loadWorkspace(root), config); assert.equal(ignorePath(root), join(root, '.csync/ignore'));
 assert.deepEqual(collectMarkdown(root), [join(root, 'doc.md')]);
 assert.equal(readFileSync(join(root, '.env'), 'utf8'), env);
 for (const name of Object.keys(legacy)) assert.equal(existsSync(join(root, name)), false);
});

test('new and legacy layouts are discovered from children and protected as nested boundaries', t => {
 const { root, put } = workspace(t, { ...legacy, 'child/doc.md': '# Child' });
 assert.equal(findSyncBase(join(root, 'child')), root);
 mkdirSync(join(root, 'child/.csync')); assert.equal(findSyncBase(join(root, 'child')), join(root, 'child'));
 assert.equal(inNestedWorkspace(root, 'child/doc.md'), true);
 assert.equal(metadataFiles(root).length, 6);
});

test('legacy files remain authoritative until explicit migration; dry-run writes nothing', t => {
 const { root } = workspace(t, { ...legacy, '.env': env, 'patents/doc.md': '# Document' });
 mockFetch(t, []);
 assert.equal(mappingPath(root), join(root, '.confluence-sync.json')); assert.equal(workspacePath(root), join(root, '.confluence-workspace.json'));
 assert.equal(migrateMetadata(root, true), 3); assert.equal(existsSync(join(root, '.csync')), false);
 assert.deepEqual(loadMapping(mappingPath(root)), mapping); assert.equal(buildIgnorer(root, []).ignores('drafts/a.md'), true);
 assert.equal(migrateMetadata(root), 3);
 for (const name of Object.keys(legacy)) assert.equal(existsSync(join(root, name)), false);
 assert.deepEqual(loadMapping(mappingPath(root)), mapping); assert.deepEqual(loadWorkspace(root), config);
 assert.equal(readFileSync(ignorePath(root), 'utf8'), 'drafts/\n'); assert.equal(readFileSync(join(root, '.env'), 'utf8'), env);
 assert.equal(readFileSync(join(root, 'patents/doc.md'), 'utf8'), '# Document'); assert.equal(migrateMetadata(root), 0);
});

test('CLI migration is offline, preserves original bytes and does not run the env wizard', t => {
 const { root } = workspace(t, { ...legacy, '.env': env });
 let result = run(root, ['init', '--migrate', '--dry-run']); assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(join(root, '.csync')), false);
 result = run(root, ['init', '--migrate']); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /3개/);
 assert.equal(readFileSync(mappingPath(root), 'utf8'), legacy['.confluence-sync.json']);
 assert.equal(readFileSync(join(root, '.env'), 'utf8'), env);
 assert.equal(run(root, ['init', '--migrate']).status, 0);
});

test('CLI refuses corrupt metadata before creating or removing any files', t => {
 const { root } = workspace(t, { ...legacy, '.confluence-sync.json': '{broken' });
 const result = run(root, ['init', '--migrate']); assert.equal(result.status, 1); assert.match(result.stderr, /매핑/);
 assert.equal(existsSync(join(root, '.csync')), false); assert.equal(readFileSync(join(root, '.confluence-sync.json'), 'utf8'), '{broken');
});

for (const [oldName, newName] of [['.confluence-sync.json', 'mapping.json'], ['.confluence-workspace.json', 'workspace.json'], ['.confluence-syncignore', 'ignore']]) test(`conflicting old and new metadata never loses either copy: ${newName}`, t => {
 const { root } = workspace(t, { ...legacy, [`.csync/${newName}`]: 'different' });
 assert.throws(() => migrateMetadata(root), /충돌/);
 assert.equal(readFileSync(join(root, oldName), 'utf8'), legacy[oldName]);
 assert.equal(readFileSync(join(root, `.csync/${newName}`), 'utf8'), 'different');
 for (const name of Object.keys(legacy)) assert.ok(existsSync(join(root, name)));
});

test('identical duplicate metadata can be migrated without changing its contents', t => {
 const { root } = workspace(t, { ...legacy, '.csync/mapping.json': legacy['.confluence-sync.json'] });
 assert.equal(mappingPath(root), join(root, '.csync/mapping.json')); migrateMetadata(root);
 assert.equal(existsSync(join(root, '.confluence-sync.json')), false); assert.deepEqual(loadMapping(mappingPath(root)), mapping);
});

test('metadata cannot be redirected through a symlink directory', t => {
 const { root } = workspace(t); const other = workspace(t); symlinkSync(other.root, join(root, '.csync'), 'junction');
 assert.throws(() => mappingPath(root), /메타데이터 폴더/); assert.throws(() => migrateMetadata(root), /메타데이터 폴더/);
 assert.equal(existsSync(join(other.root, 'mapping.json')), false);
});

test('reference links use mappings in .csync without modifying the reference workspace', t => {
 const { root, put } = workspace(t, { 'main/doc.md': '# Doc\n\n[Reference](ref.md)', 'refs/ref.md': '# Reference', 'refs/.env': env });
 const refs = join(root, 'refs'); saveMapping(mappingPath(refs), { 'ref.md': { pageId: '123' } });
 const before = readFileSync(mappingPath(refs), 'utf8');
 const renderer = buildTreeRenderer(join(root, 'main'), ['doc.md'], { referenceRoots: [refs], baseUrl: 'https://example.invalid/wiki' });
 const doc = renderer.docs['doc.md']; const rendered = renderer.render('doc.md', doc.body, doc.title);
 assert.match(rendered.storage, /pageId=123/); assert.equal(readFileSync(mappingPath(refs), 'utf8'), before);
 assert.equal(existsSync(join(refs, '.confluence-sync.json')), false);
});

test('pull from an env-only directory refuses to infer a scope and writes no state', async t => {
 configure(t);const {root}=workspace(t,{'.env':env});mockFetch(t,[]);
 await assert.rejects(runPull(['pull','--space','--out',root]),/스코프가 설정되지/);
 assert.equal(existsSync(join(root,'.csync')),false);assert.equal(readFileSync(join(root,'.env'),'utf8'),env);
});

for (const path of ['.csync/mapping.json', '.csync/workspace.json', '.csync/ignore']) test(`web preview includes new metadata content in its fingerprint: ${path}`, async t => {
 const { root, put } = workspace(t, { '.env': env, 'doc.md': '# Doc', '.csync/mapping.json': '{}', '.csync/workspace.json': '{"version":1,"syncPaths":["."]}', '.csync/ignore': 'a.md\n' });
 bindScope(root);const sync = createWebSync(async () => 0); await sync.preview(request(root)); const preview = await finished(sync); assert.equal(preview.state, 'succeeded');
 const file = join(root, path), before = statSync(file);
 const content = path.endsWith('mapping.json') ? '{"doc.md":{"pageId":"123"}}' : path.endsWith('workspace.json') ? JSON.stringify({...scopeFixture(),scope:{id:'home',type:'folder',path:'/Changed'}}) : 'b.md\n';
 put(path, content); utimesSync(file, before.atime, before.mtime);
 await assert.rejects(sync.push(preview.planId), /변경/); assert.equal(sync.current().kind, 'preview');
});
