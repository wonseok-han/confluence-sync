import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildTreeRenderer } from '../dist/sync/render.js';
import { workspace } from './helpers/fixtures.mjs';
const baseUrl = 'https://example.invalid/wiki';
function setup(t, extra = {}) {
  const fixture = workspace(t, { 'main/a.md': '# Start', 'ref/검토/문서.md': '# H1 differs',
    'ref/.confluence-sync.json': JSON.stringify({ '검토/문서.md': { pageId: '123', title: 'Old title' } }), ...extra });
  return { ...fixture, base: join(fixture.root, 'main'), refs: [join(fixture.root, 'ref')] };
}
test('wiki path, alias, and encoded Markdown path resolve to mapped page ID', t => {
  const { base, refs } = setup(t);
  const tree = buildTreeRenderer(base, ['a.md'], { referenceRoots: refs, baseUrl });
  for (const body of ['[[Vault/다른 루트/문서|표시 이름]]', '[표시 이름](../old/%EB%AC%B8%EC%84%9C.md)']) {
    const r = tree.render('a.md', body, 'Start');
    assert.match(r.storage, /href="https:\/\/example.invalid\/wiki\/pages\/viewpage.action\?pageId=123"/);
    assert.match(r.storage, /표시 이름/); assert.deepEqual(r.linkWarnings, []);
  }
});
test('unique local fallback uses H1 and places section anchors; exact local path wins', t => {
  const { base, refs } = setup(t, { 'main/문서.md': '# Local H1\n\n## Section' });
  const tree = buildTreeRenderer(base, ['a.md','문서.md'], { referenceRoots: refs, baseUrl });
  assert.match(tree.render('a.md','[[문서]]','Start').storage, /ri:content-title="Local H1"/);
  const duplicate = tree.render('a.md','[[old/문서]]','Start');
  assert.match(duplicate.linkWarnings[0], /중복/);
  const local = buildTreeRenderer(base, ['a.md','문서.md'], { referenceRoots: [], baseUrl });
  assert.match(local.render('a.md','[label](old/문서.md)','Start').storage, /ri:content-title="Local H1"/);
});
test('ambiguous references, missing files and missing mappings remain unresolved with warnings', t => {
  const { base, refs, root, put } = setup(t, { 'other/문서.md': '# Other', 'other/.confluence-sync.json': '{"문서.md":{"pageId":"456"}}' });
  let tree = buildTreeRenderer(base, ['a.md'], { referenceRoots: [...refs, join(root,'other')], baseUrl });
  const r = tree.render('a.md','[[old/문서|alias]] [other](../unknown.md)','Start');
  assert.match(r.storage, /\[\[old\/문서\|alias\]\]/); assert.ok(r.linkWarnings.some(s=>s.includes('중복'))); assert.ok(r.linkWarnings.some(s=>s.includes('대상 없는')));
  put('ref/.confluence-sync.json','{}');
  tree = buildTreeRenderer(base, ['a.md'], { referenceRoots: refs, baseUrl });
  assert.match(tree.render('a.md','[[문서]]','Start').linkWarnings[0], /게시 매핑 없는/);
});
test('different servers and corrupt mappings are rejected; repeated roots are deduplicated', t => {
  const { base, refs, put } = setup(t);
  assert.deepEqual(buildTreeRenderer(base,['a.md'],{referenceRoots:[...refs,...refs],baseUrl}).render('a.md','[[문서]]','Start').linkWarnings,[]);
  put('ref/.env','CONFLUENCE_BASE_URL=https://other.invalid/wiki');
  assert.throws(()=>buildTreeRenderer(base,['a.md'],{referenceRoots:refs,baseUrl}),/서버/);
  put('ref/.env',''); put('ref/.confluence-sync.json','[]');
  assert.throws(()=>buildTreeRenderer(base,['a.md'],{referenceRoots:refs,baseUrl}),/매핑/);
});
test('CLI repeated reference roots appear only as link inputs in dry-run', t => {
  const {base, refs, root, put} = setup(t, {'second/unpublished.md':'# Unpublished'});
  put('main/a.md','# Start\n\n[[old/문서|Alias]] [[unpublished]] [[missing]]');
  const r = spawnSync(process.execPath,['dist/sync.js','--base',base,'--reference-root',refs[0],'--reference-root',join(root,'second'),'--dry-run'],{encoding:'utf8',env:{...process.env,CONFLUENCE_BASE_URL:baseUrl}});
  assert.equal(r.status,0,r.stderr); assert.match(r.stdout,/실제 호출 없음/);
  assert.match(r.stderr,/게시 매핑 없는/); assert.match(r.stderr,/대상 없는/);
  assert.doesNotMatch(r.stdout,/H1 differs|Unpublished/);
});

test('fallback section links place anchors on local target, and nested reference roots are rejected',t=>{
 const {root,put}=workspace(t,{'main/a.md':'# A\n\n[[old/b#Section]]','main/b.md':'# B\n\n## Section','main/nested/c.md':'# C'});
 const base=join(root,'main');
 const tree=buildTreeRenderer(base,['a.md','b.md'],{referenceRoots:[],baseUrl});
 assert.match(tree.render('a.md',tree.docs['a.md'].body,'A').storage,/ac:anchor="section"/);
 assert.match(tree.render('b.md',tree.docs['b.md'].body,'B').storage,/ac:name="anchor"/);
 assert.throws(()=>buildTreeRenderer(base,['a.md'],{referenceRoots:[join(base,'nested')],baseUrl}),/밖에/);
});
