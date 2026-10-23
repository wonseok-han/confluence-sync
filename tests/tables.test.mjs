import {bindScope,scopeResponder} from './helpers/scope.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createDocument} from '@mixmark-io/domino';
import {toStorage} from '../dist/documents/markdown.js';
import {htmlToMarkdown} from '../dist/documents/html-to-markdown.js';
import {anchorPass,relinkPass,runPull} from '../dist/sync/pull.js';
import {buildTreeRenderer} from '../dist/sync/render.js';
import {workspace,mockFetch,configure} from './helpers/fixtures.mjs';

const table=(content='<strong>내용</strong>')=>`<table style="width: 760px;"><colgroup><col style="width:180px"><col style="width:580px"></colgroup><tbody><tr><th>구분</th><th>설명</th></tr><tr><td>특허</td><td>${content}</td></tr></tbody></table>`;
const widths=html=>Array.from(createDocument(html).querySelectorAll('col')).map(c=>c.getAttribute('style'));

test('colspan and rowspan survive pull and push even without explicit widths',()=>{
 const input='<table><tr><th colspan="2">조사일 / DB·자료</th><th>검색식·범위</th><th>열람 수준</th></tr><tr><td colspan="2" rowspan="2">2026-10-19<br>KIPRIS</td><td><code>query A</code></td><td>청구항 전문</td></tr><tr><td>query B</td><td><strong>원문</strong></td></tr></table>';
 const signature=html=>Array.from(createDocument(html).querySelectorAll('tr')).map(row=>Array.from(row.children).map(cell=>({text:cell.textContent.replace(/\s+/g,''),colspan:cell.getAttribute('colspan'),rowspan:cell.getAttribute('rowspan')})));
 let current=input;
 for(let i=0;i<3;i++){
  const md=htmlToMarkdown(current,{storage:current});
  assert.match(md,/<table/);assert.match(md,/colspan="2"/);assert.match(md,/rowspan="2"/);
  current=toStorage(md,'doc.md',{},'/tmp').storage;
  assert.deepEqual(signature(current),signature(input));
  assert.match(current,/<br\s*\/>/);assert.match(current,/<strong>원문<\/strong>/);
 }
});

test('merged cells retain explicit table and column widths across a round trip',()=>{
 const input=table().replace('<th>구분</th><th>설명</th>','<th colspan="2">조사 범위</th>').replace('<td>특허</td>','<td rowspan="2">특허</td>').replace('</tbody>','<tr><td>추가 내용</td></tr></tbody>');
 const storage=toStorage(htmlToMarkdown(input),'doc.md',{},'/tmp').storage;
 assert.match(storage,/colspan="2"/);assert.match(storage,/rowspan="2"/);assert.match(storage,/data-table-width="760"/);
 assert.deepEqual(widths(storage),['width: 180px;','width: 580px;']);
});

test('explicit HTML widths produce Confluence metadata and XHTML void elements',()=>{
 const {storage}=toStorage(table(),'doc.md',{},'/tmp');
 assert.match(storage,/data-table-width="760"/);assert.match(storage,/data-layout="default"/);
 assert.match(storage,/<col style="width: 180px;" \/>/);assert.match(storage,/table-layout: fixed/);
 assert.match(storage,/<strong>내용<\/strong>/);
});

test('column-only widths infer total width; percentages and invalid sizes are not interpreted as pixels',()=>{
 const input=table().replace(' style="width: 760px;"','');
 assert.match(toStorage(input,'doc.md',{},'/tmp').storage,/data-table-width="760"/);
 const invalid='<table style="width:100%"><colgroup><col style="width:-1px"><col style="width:50%"></colgroup><tr><td>A</td><td>B</td></tr></table>';
 assert.doesNotMatch(toStorage(invalid,'doc.md',{},'/tmp').storage,/data-table-width/);
});

test('normal Markdown tables and fenced HTML examples keep existing behavior',()=>{
 const plain=toStorage('| A | B |\n| --- | --- |\n| X | Y |','doc.md',{},'/tmp').storage;
 assert.doesNotMatch(plain,/data-table-width/);assert.match(htmlToMarkdown(plain),/\| A \| B \|/);
 const code=toStorage('```html\n'+table()+'\n```','doc.md',{},'/tmp').storage;
 assert.doesNotMatch(code,/data-table-width/);assert.match(code,/ac:name="code"/);
});

test('storage restores widths omitted by export_view; repeated round trips preserve layout and content',()=>{
 const original=toStorage(table(),'doc.md',{},'/tmp').storage;
 const exported='<table><tr><th>구분</th><th>설명</th></tr><tr><td>특허</td><td><strong>내용</strong></td></tr></table>';
 let md=htmlToMarkdown(exported,{storage:original});
 for(let i=0;i<3;i++){
  const storage=toStorage(md,'doc.md',{},'/tmp').storage;
  assert.match(storage,/data-table-width="760"/);assert.deepEqual(widths(storage),['width: 180px;','width: 580px;']);
  assert.equal(createDocument(storage).querySelector('tbody').textContent.replace(/\s/g,''),'구분설명특허내용');
  md=htmlToMarkdown(storage,{storage});
 }
 assert.doesNotMatch(md,/;;/);
});

test('multiple tables retain separate widths and widthless tables stay Markdown',()=>{
 const html='<table><tr><th>Plain</th></tr></table>'+table()+table().replaceAll('760','900').replaceAll('580','720');
 const md=htmlToMarkdown(html,{storage:html});
 assert.match(md,/\| Plain \|/);assert.deepEqual(widths(md),['width: 180px;','width: 580px;','width: 180px;','width: 720px;']);
 const mismatched=htmlToMarkdown('<table><tr><th>Other</th></tr></table>',{storage:html});
 assert.match(mismatched,/\| Other \|/);assert.doesNotMatch(mismatched,/<table/);
});

test('HTML table links and images use normal page, attachment and rewrite rules',t=>{
 const {root}=workspace(t,{'report.pdf':'pdf','image.png':'png'});
 const html=table('<a href="report.pdf#page=2">첨부</a> <a href="other.md#section">문서</a> <a href="https://example.com?a=1&amp;b=2">외부</a> <img src="image.png" width="240">');
 const result=toStorage(html,'doc.md',{'other.md':'Other'},root,{anchorIndex:{'other.md':new Map([['section','Section']])}});
 assert.equal(result.attachments.length,2);assert.equal(result.images.length,1);assert.equal(result.internalLinks,1);
 assert.match(result.storage,/ri:filename="report.pdf"/);assert.match(result.storage,/ac:anchor="page=2"/);
 assert.match(result.storage,/ri:content-title="Other"/);assert.match(result.storage,/ac:width="240"/);
 assert.match(result.storage,/href="https:\/\/example.com\?a=1&amp;b=2"/);
 const rewritten=toStorage(table('<a href="other.md">X</a>'),'doc.md',{},root,{rewriteHref:()=> 'https://example.com/pages/2'});
 assert.match(rewritten.storage,/href="https:\/\/example.com\/pages\/2"/);
});

test('width-preserving pull downloads table images and files with local HTML links',async t=>{
 const {root,put}=workspace(t);configure(t);bindScope(root);put('.csync/mapping.json',JSON.stringify({'Table.md':{pageId:'123'}}));
 const html=table('<a href="/download/attachments/123/report.pdf?version=1">파일</a> <img src="/download/attachments/123/image.png">');
 const steps=[{path:'/wiki/rest/api/content/123?expand=body.export_view,body.storage,version',body:{id:'123',title:'Table',type:'page',body:{export_view:{value:html},storage:{value:html}},_links:{base:'https://example.invalid',webui:'/wiki/pages/123'}}},{path:'/wiki/rest/api/content/123/child/attachment?limit=100',body:{results:[{title:'report.pdf',_links:{download:'/download/report.pdf'}},{title:'image.png',_links:{download:'/download/image.png'}}]}},{path:'/wiki/download/image.png',bytes:new Uint8Array([2])},{path:'/wiki/download/report.pdf',bytes:new Uint8Array([1])}];mockFetch(t,steps,scopeResponder(root,steps));
 await runPull(['pull','123','--out',root]);
 const md=readFileSync(join(root,'Table.md'),'utf8');
 assert.match(md,/href="attachments\/Table\/report.pdf"/);assert.match(md,/src="attachments\/Table\/image.png"/);
 assert.deepEqual(readFileSync(join(root,'attachments/Table/report.pdf')),Buffer.from([1]));
 const result=toStorage(md,'Table.md',{},root);assert.equal(result.attachments.length,2);assert.match(result.storage,/data-table-width="760"/);
});

test('HTML table page and self anchors are relinked without touching code examples',t=>{
 const {put}=workspace(t);
 const html=table('<a href="https://example.invalid/wiki/spaces/T/pages/2/B#BSection">B</a> <a href="#ASelf">self</a>');
 const a=put('a.md','---\ntitle: A\n---\n## Self\n\n'+html+'\n\n```html\n'+html+'\n```\n');
 const b=put('nested/b.md','---\ntitle: B\n---\n## Section\n');const paths=new Map([['1',a],['2',b]]);
 const pass=anchorPass([a,b],paths);assert.equal(pass.count,2);assert.equal(relinkPass([a,b],paths,true,pass.info),1);
 const text=readFileSync(a,'utf8');assert.match(text,/href="nested\/b.md#section"/);assert.match(text,/href="#self"/);
 assert.match(text.split('```html')[1],/pages\/2\/B#BSection/);
});

test('HTML table section links cause the tree renderer to insert target anchor macros',t=>{
 const {root}=workspace(t,{'a.md':'# A\n\n'+table('<a href="b.md#section">B</a>'),'b.md':'# B\n\n## Section\nText'});
 const tree=buildTreeRenderer(root,['a.md','b.md']);
 assert.match(tree.render('a.md',tree.docs['a.md'].body,'A').storage,/ac:anchor="section"/);
 assert.match(tree.render('b.md',tree.docs['b.md'].body,'B').storage,/ac:name="anchor"/);
});

test('blank lines inside an HTML table retain attachment handling and following Markdown',t=>{
 const {root}=workspace(t,{'report.pdf':'pdf'});
 const input=table('<a href="report.pdf">파일</a>').replace('</tr>','</tr>\n\n')+'\n\n## Following\n';
 const result=toStorage(input,'doc.md',{},root);
 assert.equal(result.attachments.length,1);assert.match(result.storage,/ri:filename="report.pdf"/);
 assert.match(result.storage,/<h2>Following<\/h2>/);assert.match(result.storage,/data-table-width="760"/);
 const code=toStorage('    '+table('<a href="report.pdf">파일</a>'),'doc.md',{},root);
 assert.equal(code.attachments.length,0);
});
