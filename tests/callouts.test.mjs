import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {workspace} from './helpers/fixtures.mjs';
import {toStorage} from '../dist/documents/markdown.js';
import {buildTreeRenderer} from '../dist/sync/render.js';
import {preparePushTree} from '../dist/sync/prepare.js';
import {previewDocument} from '../dist/web/preview.js';

const storage=source=>toStorage(source,'doc.md',{},'/tmp').storage;
test('summary callout becomes a titled Confluence panel with rich text body',()=>{
 const result=storage('> [!summary]\n> **핵심 내용**\n>\n> - 첫째\n> - 둘째\n');
 assert.match(result,/ac:name="panel"/);assert.match(result,/ac:name="title">요약<\/ac:parameter>/);assert.match(result,/<strong>핵심 내용<\/strong>/);assert.match(result,/<ul>/);assert.doesNotMatch(result,/\[!summary\]/);
});

for(const [type,title,color] of [['ABSTRACT','요약','#e6fcff'],['tldr','요약','#e6fcff'],['info','안내','#deebff'],['note','노트','#f4f5f7'],['tip','팁','#e6fcff'],['important','팁','#e6fcff'],['success','성공','#e3fcef'],['done','성공','#e3fcef'],['warning','주의','#fff0b3'],['caution','주의','#fff0b3'],['danger','위험','#ffebe6'],['error','위험','#ffebe6'],['custom-type','노트','#f4f5f7'],['__proto__','노트','#f4f5f7']])test(`callout ${type} selects its title and color safely`,()=>{
 const result=storage(`> [!${type}]\n> Body`);assert.ok(result.includes(`ac:name="title">${title}</ac:parameter>`));assert.ok(result.includes(`ac:name="bgColor">${color}</ac:parameter>`));
});

test('custom titles are escaped and fold markers do not leak into output',()=>{
 for(const marker of ['','+','-']){
  const result=storage(`> [!warning]${marker} <script>alert(1)</script> & "Title"\n> Body`);
  assert.match(result,/&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;Title&quot;/);assert.doesNotMatch(result,/<script>|\[!warning\]/);assert.match(result,/<p>Body<\/p>/);
 }
 assert.match(storage('> [!note] Title only'),/ac:name="title">Title only<\/ac:parameter>/);
});

test('nested callouts preserve rich text and ordinary nested quotes',()=>{
 const result=storage('> [!summary] Outer\n> Intro\n>\n> > [!warning] Inner\n> > **Risk**\n>\n> > Ordinary quote\n\nAfter');
 assert.equal((result.match(/ac:name="panel"/g)||[]).length,2);assert.equal((result.match(/<ac:rich-text-body>/g)||[]).length,2);assert.equal((result.match(/<\/ac:rich-text-body>/g)||[]).length,2);assert.match(result,/<strong>Risk<\/strong>/);assert.match(result,/<blockquote>\n<p>Ordinary quote/);assert.ok(result.endsWith('<p>After</p>\n'));
});

test('plain quotes, escaped markers, inline text and code examples stay unchanged',()=>{
 for(const source of ['> Normal quote','[!summary] outside a quote','> \\[!summary] escaped','```md\n> [!summary]\n> example\n```','    > [!summary]\n    > example','> `[!summary]` code']){
  assert.doesNotMatch(storage(source),/ac:name="panel"/);
 }
 const result=storage('> [!note]\n> ```md\n> [!warning] example\n> ```');assert.equal((result.match(/ac:name="panel"/g)||[]).length,1);assert.match(result,/\[!warning\] example/);
});

test('callout bodies share page links, image attachments and table rendering',t=>{
 const {root}=workspace(t,{'doc.md':'# Doc\n\n> [!summary] Links\n> [[Other|Related]] ![[image.png]]\n>\n> | A | B |\n> |---|---|\n> | 1 | 2 |','Other.md':'# Other','image.png':'image'});
 const tree=buildTreeRenderer(root,['doc.md','Other.md']),doc=tree.docs['doc.md'];const result=tree.render('doc.md',doc.body,doc.title);
 assert.match(result.storage,/ri:content-title="Other"/);assert.match(result.storage,/ri:filename="image.png"/);assert.match(result.storage,/<table>/);assert.equal(result.internalLinks,1);assert.equal(result.attachments.length,1);
});

test('automatic preparation and HTML preview both handle callouts without editing the original',async t=>{
 const {root}=workspace(t,{'doc.md':'# Doc\n\n> [!summary] 요약\n> 핵심 **내용**\n\n> [!danger] 위험\n> 주의할 사항'});const before=readFileSync(join(root,'doc.md'),'utf8');
 const tree=await preparePushTree(root,['doc.md'],['doc.md']);
 try{assert.equal((tree.render('doc.md',tree.docs['doc.md'].body,'Doc').storage.match(/ac:name="panel"/g)||[]).length,2)}finally{tree.dispose()}
 const preview=await previewDocument(root,join(root,'doc.md'));assert.doesNotMatch(preview.html,/\[!summary\]|\[!danger\]/);assert.match(preview.html,/background-color:#e6fcff/);assert.match(preview.html,/<strong>요약<\/strong>/);assert.equal(readFileSync(join(root,'doc.md'),'utf8'),before);
});
