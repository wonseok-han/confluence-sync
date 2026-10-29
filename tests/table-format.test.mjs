import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createDocument} from '@mixmark-io/domino';
import {editableTables,formatTable,createTableFormatting,sourceHash} from '../dist/web/table-format.js';
import {previewDocument} from '../dist/web/preview.js';
import {workspace} from './helpers/fixtures.mjs';

const raw='<table style="width:760px"><colgroup><col style="width:200px"><col style="width:400px"><col style="width:160px"></colgroup><thead><tr><th>날짜</th><th rowspan="2">검색식</th><th rowspan="2">열람</th></tr><tr><th>DB</th></tr></thead><tbody><tr><td>2026-10-23</td><td rowspan="2"><a href="report.pdf">첨부</a></td><td rowspan="2"><strong>원문</strong></td></tr><tr><td>KIPRIS</td></tr></tbody></table>';

test('raw table resizing preserves every cell and merge attribute and changes only the selected source range',()=>{
 const source='---\ntitle: Keep\n---\n# Header\n\n'+raw+'\n\nTail\n';
 assert.deepEqual(editableTables(source)[0].widths,[200,400,160]);assert.equal(editableTables(source)[0].editable,true);
 const changed=formatTable(source,0,[150,450,160]);assert.ok(changed.startsWith('---\ntitle: Keep\n---\n# Header\n\n'));assert.ok(changed.endsWith('\n\nTail\n'));
 const signature=s=>Array.from(createDocument(s).querySelectorAll('th,td')).map(c=>[c.innerHTML,c.getAttribute('rowspan'),c.getAttribute('colspan')]);
 assert.deepEqual(signature(changed),signature(source));assert.match(changed,/width: 150px/);assert.match(changed,/width: 760px/);
 assert.equal(changed.slice(changed.indexOf('<thead>')),source.slice(source.indexOf('<thead>')));
});

test('Markdown tables become HTML without rewriting surrounding prose, code examples, or another table',()=>{
 const table='| 구분 | 내용 |\n| --- | --- |\n| A | **굵게** [첨부](report.pdf) |\n';
 const source='Intro\n\n```html\n'+raw+'\n```\n\n'+table+'\n'+raw+'\nTail';
 assert.equal(editableTables(source).length,2);
 const result=formatTable(source,0,[100,660]);
 assert.ok(result.startsWith(source.slice(0,source.indexOf(table))));assert.ok(result.endsWith('\n'+raw+'\nTail'));
 assert.match(result,/<strong>굵게<\/strong>/);assert.match(result,/href="report.pdf"/);assert.match(result,/<col style="width: 100px;">/);
});

test('source ranges preserve CRLF documents and merged-only headers use logical column counts',()=>{
 const source='# Title\r\n\r\n| A | B |\r\n| --- | --- |\r\n| X | Y |\r\n\r\nTail\r\n';
 const result=formatTable(source,0,[200,560]);assert.ok(result.startsWith('# Title\r\n\r\n'));assert.ok(result.endsWith('\r\nTail\r\n'));
 const merged='<table><tr><th colspan="3">All</th></tr><tr><td>A</td><td>B</td><td>C</td></tr></table>';
 assert.equal(editableTables(merged)[0].widths.length,3);
 assert.match(formatTable(merged,0,[120,320,320]),/colspan="3"/);
});

test('nested/unsupported tables and invalid widths fail without producing a patch',()=>{
 const nested='<table><tr><td><table><tr><td>Inner</td></tr></table></td></tr></table>';
 assert.ok(editableTables(nested).every(t=>!t.editable));
 for(const widths of [[39,500,221],[100,660],[-1,600,161],[100,600,Infinity],[1000,1000,1001]])assert.throws(()=>formatTable(raw,0,widths));
 assert.throws(()=>formatTable(raw,8,[100,660]));
});

test('existing Confluence width metadata agrees with resized CSS and column widths',()=>{
 const source=raw.replace('<table ', '<table data-table-width="960" ');
 const result=formatTable(source,0,[120,400,200]);
 assert.match(result,/data-table-width="720"/);assert.match(result,/width: 720px/);
});

test('review plans are read-only until saved, support multiple tables, and reject changed files',async t=>{
 const {root,put}=workspace(t);const source='# Title\n\n'+raw+'\n\n'+raw+'\n';const file=put('doc.md',source);const formatter=createTableFormatting();
 const plan=await formatter.preview(root,file,sourceHash(source),0,[120,480,160],[{index:0,widths:[120,480,160]},{index:1,widths:[180,380,200]}]);
 assert.equal(readFileSync(file,'utf8'),source);
 await formatter.save(plan.planId);assert.equal(readFileSync(file,'utf8'),plan.after);assert.deepEqual(readdirSync(root),['doc.md']);
 await assert.rejects(formatter.save(plan.planId),/다시/);
 const pending=await formatter.preview(root,file,sourceHash(plan.after),0,[200,400,160]);
 put('doc.md',plan.after+'External edit');await assert.rejects(formatter.save(pending.planId),/변경/);assert.match(readFileSync(file,'utf8'),/External edit$/);
 await assert.rejects(formatter.preview(root,file,sourceHash(source),0,[200,400,160]),/변경/);
});

test('review refuses a symlink escaping the selected root and preview bridge is trusted-only',async t=>{
 const {root,put}=workspace(t);const {put:outside}=workspace(t);const file=put('doc.md',raw);
 const formatter=createTableFormatting();symlinkSync(outside('secret.md',raw),join(root,'escape.md'));
 await assert.rejects(formatter.preview(root,join(root,'escape.md'),sourceHash(raw),0,[200,400,160]),/폴더 안/);
 const result=await previewDocument(root,file,'test-nonce');
 assert.equal(result.hash,sourceHash(raw));assert.equal(result.tables.length,1);assert.match(result.html,/script nonce="test-nonce"/);assert.match(result.html,/data-csync-table="0"/);
 assert.match(result.html,/script-src 'nonce-test-nonce'/);
});

test('content fit gives short identifiers less space and long descriptions more space at the same total width',async()=>{
 const {fitColumnWidths}=await import('../src/web/client/table-format.js');
 const rows=Array.from({length:12},(_,i)=>`<tr><td>${i+1}</td><td>비특허</td><td>${'구체적인 조사 내용과 비교 설명 '.repeat(8)}</td></tr>`).join('');
 const source='<table><tr><th>번호</th><th>구분</th><th>설명</th></tr>'+rows+'</table>';
 const weights=editableTables(source)[0].contentWeights;
 for(const total of [320,760,1200]){
  const widths=fitColumnWidths(total,weights);assert.equal(widths.reduce((a,b)=>a+b,0),total);assert.ok(widths.every(w=>Number.isInteger(w)&&w>=40));assert.ok(widths[0]<widths[1]&&widths[1]<widths[2]);
 }
 const widths=fitColumnWidths(760,weights);assert.ok(widths[0]<120);assert.ok(widths[2]>400);
 assert.match(formatTable(source,0,widths),/width: 760px/);
});

test('content fit accounts for wide characters, rowspan column positions and colspan sharing',async()=>{
 const {fitColumnWidths}=await import('../src/web/client/table-format.js');
 const wide='<table><tr><th>X</th><th>X</th></tr><tr><td>aaaa</td><td>가가가가</td></tr></table>';
 const widths=fitColumnWidths(760,editableTables(wide)[0].contentWeights);assert.ok(widths[1]>widths[0]);
 const merged='<table><tr><th colspan="2">조사 정보</th><th rowspan="2">검색 내용</th></tr><tr><th>번호</th><th>구분</th></tr><tr><td>1</td><td>A</td><td rowspan="2">'+ '긴 설명 '.repeat(40)+'</td></tr><tr><td>2</td><td>B</td></tr></table>';
 const fit=fitColumnWidths(760,editableTables(merged)[0].contentWeights);assert.equal(fit.length,3);assert.ok(fit[2]>fit[0]&&fit[2]>fit[1]);
 const result=formatTable(merged,0,fit);assert.match(result,/colspan="2"/);assert.match(result,/rowspan="2"/);
});

test('a single very long outlier does not dominate an otherwise short column',async()=>{
 const {fitColumnWidths}=await import('../src/web/client/table-format.js');
 const rows=Array.from({length:20},(_,i)=>`<tr><td>${i===0?'X'.repeat(10000):i}</td><td>${'상세 설명 '.repeat(12)}</td></tr>`).join('');
 const weights=editableTables('<table>'+rows+'</table>')[0].contentWeights;
 const widths=fitColumnWidths(760,weights);assert.ok(widths[0]<widths[1]);assert.equal(widths.reduce((a,b)=>a+b,0),760);
 const empty=editableTables('<table><tr><td></td><td></td></tr></table>')[0].contentWeights;
 assert.deepEqual(fitColumnWidths(760,empty),[380,380]);
});
