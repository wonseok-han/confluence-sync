import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import MarkdownIt from 'markdown-it';
import {formatDocument} from '../dist/documents/format.js';
import {formatAllTables,editableTables,createTableFormatting,sourceHash} from '../dist/web/table-format.js';
import {workspace} from './helpers/fixtures.mjs';
const md=new MarkdownIt({html:true});
test('basic formatting is idempotent and preserves frontmatter, code, HTML, hard breaks and link targets',()=>{
 const front='---\ntitle: Keep   \n---\n\n';
 const code='```md\n한글\\_코드   \n\n\n```';
 const html='<table style="width:420px"><tr><td colspan="2">Keep   </td></tr></table>';
 const body='##   Heading ##\nText   \n\n\n* One\n* Two\n\n'+code+'\n\n'+html+'\n\n[한글\\_링크](path\\_keep.md)\n\n한글\\_제목\n';
 const result=formatDocument(front+body);
 assert.ok(result.startsWith(front));assert.ok(result.includes(code));assert.ok(result.includes(html));assert.ok(result.includes('[한글\\_링크](path\\_keep.md)'));
 assert.match(result,/## Heading\n\nText  \n/);assert.match(result,/- One\n- Two/);assert.match(result,/한글_제목/);assert.equal(formatDocument(result),result);
});
test('Markdown table alignment retains cell contents and alignment without changing rendering',()=>{
 const source='| A | 긴 내용 |\n|:---|---:|\n| `a\\|b` | [x](a.md) |\n';
 const result=formatDocument(source);assert.equal(md.render(result),md.render(source));assert.match(result,/\| :---/);assert.equal(formatDocument(result),result);
});
test('CRLF and nested list/blockquote structure survive formatting',()=>{
 const source='- Parent\r\n  * Child\r\n\r\n> Quote\r\n>\r\n> Paragraph\r\n\r\n    code  \r\n';
 const result=formatDocument(source);assert.equal(result.replace(/\r\n/g,'' ).includes('\n'),false);assert.equal(md.render(result),md.render(source));
});
const table='| 구분 | 설명 |\n| --- | --- |\n| A | 아주 긴 설명을 충분하게 적어둔 열입니다 |\n';
const html='<table style="width:420px"><tr><th colspan="2">Title</th></tr><tr><td>A</td><td>Long description text</td></tr></table>';
for(const mode of ['fit','equal'])test(`bulk ${mode} formats every editable table, preserves totals and merged cells`,()=>{
 const source=table+'\n'+html+'\n\n```html\n'+html+'\n```\n';
 const before=editableTables(source),after=formatAllTables(source,mode),tables=editableTables(after);
 assert.equal(tables.length,2);assert.match(after,/colspan="2"/);assert.ok(after.endsWith('```html\n'+html+'\n```\n'));
 for(let i=0;i<2;i++)assert.equal(tables[i].widths.reduce((a,b)=>a+b),before[i].widths.reduce((a,b)=>a+b));
 if(mode==='equal')assert.deepEqual(tables.map(t=>t.widths),[[380,380],[210,210]]);else assert.ok(tables[0].widths[1]>tables[0].widths[0]);
});
test('document formatting previews without writes, saves exact review, and rejects stale source',async t=>{
 const original='#   Title\nText\n\n'+table;const {root,put}=workspace(t,{'a.md':original});const f=createTableFormatting();
 const plan=await f.documentPreview(root,join(root,'a.md'),sourceHash(original),true,'equal');assert.equal(readFileSync(join(root,'a.md'),'utf8'),original);assert.match(plan.after,/width: 380px/);
 put('a.md','External edit');await assert.rejects(f.save(plan.planId),/파일이 변경/);assert.equal(readFileSync(join(root,'a.md'),'utf8'),'External edit');
 put('a.md',original);const approved=await f.documentPreview(root,join(root,'a.md'),sourceHash(original),true,'keep');await f.save(approved.planId);assert.equal(readFileSync(join(root,'a.md'),'utf8'),approved.after);
 await assert.rejects(f.documentPreview(root,join(root,'a.md'),'stale',true,'keep'),/파일이 변경/);
});

test('multiline inline code is preserved byte for byte',()=>{
 const code='`start\n한글\\_코드   \n## not a heading\nend`';
 assert.ok(formatDocument('Before\n\n'+code+'\n\nAfter\n').includes(code));
});

test('raw HTML tables with blank lines retain all source bytes and merged cells',()=>{
 const table='<table style="width:100%">\n\n<tr><td colspan="2">\nContent   \n\n\nMore\n</td></tr>\n\n</table>';
 assert.ok(formatDocument('# Title\nText\n\n'+table+'\n').includes(table));
});

test('one document review combines basic formatting with exact per-table edits',async t=>{
 const original='#   Title\nText\n\n'+table+'\n'+html+'\n';const {root}=workspace(t,{'a.md':original});const f=createTableFormatting();
 const plan=await f.documentPreview(root,join(root,'a.md'),sourceHash(original),true,'keep',[{index:0,widths:[120,640]},{index:1,widths:[80,340]}]);
 assert.match(plan.after,/# Title\n\nText/);assert.deepEqual(editableTables(plan.after).map(t=>t.widths),[[120,640],[80,340]]);assert.equal(readFileSync(join(root,'a.md'),'utf8'),original);
 await f.save(plan.planId);assert.equal(readFileSync(join(root,'a.md'),'utf8'),plan.after);
});
