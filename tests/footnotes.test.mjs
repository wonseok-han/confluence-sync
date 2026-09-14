import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { footnotesToLinks } from '../dist/footnotes.js';
import { resolveWikilinks } from '../dist/obsidian.js';
import { buildTreeRenderer } from '../dist/render.js';
import { toStorage } from '../dist/markdown.js';

test('repeated references, multiline notes, code, escapes and undefined references', () => {
  const src = '# Title\n\nA[^x] B[^x] `[^x]` \\[^x] [^missing]\n\n```md\n[^x]\n[^fake]: example\n```\n\n[^x]: **Bold**\n    continued\n\n    second paragraph\n';
  const out = footnotesToLinks(src);
  assert.equal((out.match(/<sup>\[1\]/g) || []).length, 2);
  assert.match(out, /`\[\^x\]`/);
  assert.match(out, /\\\[\^x\]/);
  assert.match(out, /\[\^missing\]/);
  assert.match(out, /\[\^fake\]: example/);
  assert.match(out, /\*\*Bold\*\*\ncontinued\n\nsecond paragraph/);
  assert.equal(footnotesToLinks(out), out);
});

test('heading collision, unused definitions and first-reference ordering', () => {
  const out = footnotesToLinks('### 각주 1\n\nB[^b] A[^a]\n\n[^a]: Alpha\n[^b]: Beta\n[^unused]: Preserve\n');
  assert.match(out, /B<sup>\[1\]\(#각주-1-1\)/);
  assert.match(out, /^###### 각주 1-1\n\nBeta/m);
  assert.match(out, /^###### 각주 2\n\nAlpha/m);
  assert.match(out, /Preserve/);
});

test('PDF fragment survives wikilink conversion', () => {
  assert.equal(resolveWikilinks('[[doc.pdf#page=3|원문]]', () => 'assets/doc.pdf'), '[원문](assets/doc.pdf#page=3)');
});

test('converted superscript references resolve to actual Confluence anchors', () => {
  const base = mkdtempSync(join(tmpdir(), 'footnotes-'));
  try {
    writeFileSync(join(base, 'a.md'), footnotesToLinks('# Title\n\nA[^a] again[^a]\n\n[^a]: note\n'));
    const tree = buildTreeRenderer(base, ['a.md']);
    const doc = tree.docs['a.md'];
    const r = tree.render('a.md', doc.body, doc.title);
    assert.equal(r.deadAnchors.length, 0);
    assert.equal(r.anchorsPlaced, 1);
    assert.equal(r.anchorLinks, 2);
    assert.match(r.storage, /<sup><ac:link ac:anchor="각주-1">/);
  } finally { rmSync(base, {recursive: true, force: true}); }
});

test('iframe URL is emitted as an escaped macro and invalid protocols rejected', () => {
  const r = toStorage('```confluence-iframe\nhttps://example.org/viewer.html?x=1&y=2#page=3\n```', 'a.md', {}, '.');
  assert.match(r.storage, /ac:name="iframe"/);
  assert.match(r.storage, /x=1&amp;y=2#page=3/);
  assert.throws(() => toStorage('```confluence-iframe\njavascript:alert(1)\n```', 'a.md', {}, '.'));
});
