import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {footnotesToLinks,linksToFootnotes} from '../dist/footnotes.js';
import {buildTreeRenderer} from '../dist/render.js';
const cli=resolve('dist/sync.js');
function makePdf(path) {
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>'];
 for(let i=0;i<3;i++)objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents ${6+i} 0 R >>`);
 for(const color of ['1 0 0','0 1 0','0 0 1']) { const stream=`${color} rg 0 0 200 200 re f`; objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); }
 let s='%PDF-1.4\n';const offsets=[0];
 objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(s));s+=`${i+1} 0 obj\n${o}\nendobj\n`;});
 const xref=Buffer.byteLength(s);s+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
 s+=offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
 s+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;writeFileSync(path,s);
}
function setup(){const root=mkdtempSync(join(tmpdir(),'csync-roundtrip-'));const input=join(root,'input');mkdirSync(join(input,'refs'),{recursive:true});makePdf(join(input,'refs','원본 공고.pdf'));return {root,input};}
function convert(input,out,to='markdown',dry=false){return execFileSync(process.execPath,[cli,'convert','--to',to,'--base',input,'--out',out,...(dry?['--dry-run']:[])],{encoding:'utf8',stdio:'pipe'});}

test('real CLI: PDF in footnotes -> one PNG -> original PDF references and edited notes',()=>{
 const {root,input}=setup();try{
 const source='# 문서\n\n첫째[^law] 다시[^law].\n\n[^law]: 설명 [원문](<refs/원본 공고.pdf#page=3>)\n\n같은 쪽 [[refs/원본 공고.pdf#page=3|추가 근거]]\n';
 writeFileSync(join(input,'doc.md'),source);const out=join(root,'markdown');convert(input,out);
 let md=readFileSync(join(out,'doc.md'),'utf8');
 assert.equal(readdirSync(join(out,'attachments/pdf-pages')).length,1);
 assert.equal(readdirSync(join(out,'attachments/files')).length,1);
 assert.equal(existsSync(join(out,'refs')),false);
 assert.equal(readFileSync(join(input,'doc.md'),'utf8'),source);
 assert.match(md,/csync-pdf:v1/);assert.doesNotMatch(md,/\[\^law\]/);
 const tree=buildTreeRenderer(out,['doc.md']),d=tree.docs['doc.md'];const r=tree.render('doc.md',d.body,d.title);
 assert.deepEqual(r.deadAnchors,[]);assert.equal(r.images.length,2);assert.match(r.storage,/ac:anchor="pdf-원문-1---3쪽"/);
 md=md.replace('설명 ![원문]','수정한 설명 ![원문]');writeFileSync(join(out,'doc.md'),md);
 const back=join(root,'obsidian');convert(out,back,'obsidian');
 const restored=readFileSync(join(back,'doc.md'),'utf8');
 assert.equal((restored.match(/\[\^law\]/g)||[]).length,3);
 assert.match(restored,/\[\^law\]: 수정한 설명 \[\[attachments\/files\/[^\]]+원본 공고.pdf#page=3\|원문\]\]/);
 assert.match(restored,/\[\[attachments\/files\/[^\]]+원본 공고.pdf#page=3\|추가 근거\]\]/);
 assert.doesNotMatch(restored,/csync-|pdf-pages/);assert.equal(readdirSync(join(back,'attachments/files')).length,1);
 assert.equal(existsSync(join(back,'refs')),false);
 const again=join(root,'again');convert(back,again);assert.equal(readdirSync(join(again,'attachments/pdf-pages')).length,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('dry-run writes nothing; out-of-range and unresolved wiki PDF fail before writing document',()=>{
 const {root,input}=setup();try{
 writeFileSync(join(input,'a.md'),'PDF [[refs/원본 공고.pdf#page=3|출처]]');const out=join(root,'out');convert(input,out,'markdown',true);assert.equal(existsSync(out),false);
 for(const ref of ['[[refs/원본 공고.pdf#page=9|출처]]','[[없는.pdf#page=3|출처]]']){
 writeFileSync(join(input,'a.md'),ref);assert.throws(()=>convert(input,out));assert.equal(existsSync(join(out,'a.md')),false);
 }
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('footnote restoration preserves edited multiline body and fenced examples',()=>{
 const source='A[^a]\n\n[^a]: first\n\n    ```txt\n    literal [^a]\n    ```\n\n    last\n';
 const md=footnotesToLinks(source).replace('first','edited');const back=linksToFootnotes(md);
 assert.match(back,/\[\^a\]: edited/);assert.match(back,/    ```txt\n    literal \[\^a\]\n    ```/);
 assert.equal(linksToFootnotes('```md\n'+md+'\n```'),'```md\n'+md+'\n```');
});

test('PDF embed keeps its page and returns to an Obsidian embed; code references stay literal',()=>{
 const {root,input}=setup();try{
 writeFileSync(join(input,'a.md'),'# Embed\n\n![[refs/원본 공고.pdf#page=2|두 번째 쪽]]\n\n`[code](<refs/원본 공고.pdf#page=99>)`\n\n```md\n[[missing.pdf#page=99]]\n```\n');
 const out=join(root,'out');convert(input,out);assert.equal(readdirSync(join(out,'attachments/pdf-pages')).length,1);
 const back=join(root,'back');convert(out,back,'obsidian');const text=readFileSync(join(back,'a.md'),'utf8');
 assert.match(text,/!\[\[attachments\/files\/[^\]]+원본 공고.pdf#page=2\|두 번째 쪽\]\]/);
 assert.match(text,/`\[code\]\(<refs\/원본 공고.pdf#page=99>\)`/);
 const copy=join(root,'copy');convert(out,copy);assert.equal(readdirSync(join(copy,'attachments/files')).length,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('external absolute and parent-relative attachments remain portable in both directions',()=>{
 const {root,input}=setup();try{
 const outside=join(root,'outside');mkdirSync(join(outside,'a'),{recursive:true});mkdirSync(join(outside,'b'));
 makePdf(join(outside,'source.pdf'));
 writeFileSync(join(outside,'a','same.png'),'first-image');writeFileSync(join(outside,'b','same.png'),'second-image');
 const original='# Document\n\n[Self](#document) [Web](https://example.com/manual.pdf#page=3)\n\n'
  +`![A](<${outside}/a/same.png>)\n\n![B](../outside/b/same.png)\n\n`
  +`PDF[^pdf]\n\n[^pdf]: [Source](<${outside}/source.pdf#page=3>)\n\n`
  +`[Download](<${pathToFileURL(join(outside,'source.pdf')).href}>)\n\n\`![Code](${outside}/a/same.png)\`\n`;
 writeFileSync(join(input,'doc.md'),original);
 const out=join(root,'out');convert(input,out,'markdown',true);assert.equal(existsSync(out),false);
 convert(input,out);const md=readFileSync(join(out,'doc.md'),'utf8');
 assert.match(md,/\[Self\]\(#document\)/);assert.match(md,/https:\/\/example.com\/manual.pdf#page=3/);
 assert.equal(readdirSync(join(out,'attachments/files')).length,3);
 const tree=buildTreeRenderer(out,['doc.md']),doc=tree.docs['doc.md'];
 assert.deepEqual(tree.render('doc.md',doc.body,doc.title).deadAnchors,[]);
 const direct=join(root,'direct');convert(input,direct,'obsidian');
 const obsidian=readFileSync(join(direct,'doc.md'),'utf8');assert.match(obsidian,/\[\[attachments\/files\/[^\]]+source.pdf#page=3\|Source\]\]/);
 assert.equal(readdirSync(join(direct,'attachments/files')).length,3);
 assert.equal(readFileSync(join(input,'doc.md'),'utf8'),original);
 rmSync(outside,{recursive:true});
 const back=join(root,'back');convert(out,back,'obsidian');
 assert.match(readFileSync(join(back,'doc.md'),'utf8'),/\[\^pdf\]: \[\[attachments\/files\/[^\]]+source.pdf#page=3\|Source\]\]/);
 const again=join(root,'again');convert(back,again);
 assert.equal(readdirSync(join(again,'attachments/pdf-pages')).length,1);
 assert.equal(readdirSync(join(again,'attachments/files')).length,3);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('absolute Obsidian embeds and subfolder documents use copied relative attachments',()=>{
 const {root,input}=setup();try{
 const pdf=join(root,'outside.pdf');makePdf(pdf);mkdirSync(join(input,'notes'));
 writeFileSync(join(input,'notes','doc.md'),`# Nested\n\n![[${pdf}#page=2|Page two]]`);
 const out=join(root,'out');convert(input,out);
 const md=readFileSync(join(out,'notes','doc.md'),'utf8');assert.match(md,/\.\.\/attachments\/pdf-pages/);
 rmSync(pdf);const back=join(root,'back');convert(out,back,'obsidian');
 assert.match(readFileSync(join(back,'notes','doc.md'),'utf8'),/!\[\[attachments\/files\/[^\]]+outside.pdf#page=2\|Page two\]\]/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('in-base images and PDFs are consolidated under attachments in both directions',()=>{
 const {root,input}=setup();try{
 mkdirSync(join(input,'images'));writeFileSync(join(input,'images','screen.png'),'image bytes');
 writeFileSync(join(input,'doc.md'),'# Files\n\n![Screen](images/screen.png)\n\n[PDF](<refs/원본 공고.pdf>)');
 for(const direction of ['markdown','obsidian']) {
  const out=join(root,direction);convert(input,out,direction);
  assert.deepEqual(readdirSync(out).sort(),['attachments','doc.md']);
  const md=readFileSync(join(out,'doc.md'),'utf8');assert.match(md,/attachments\/files\//);
  assert.doesNotMatch(md,/images\/|refs\//);
  assert.equal(readdirSync(join(out,'attachments/files')).length,2);
 }
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('footnote-only PDF appears inside its H6 note without a separate gallery and roundtrips',()=>{
 const {root,input}=setup();try{
 writeFileSync(join(input,'doc.md'),'# Note\n\nSee[^pdf]\n\n[^pdf]: 설명 [Source](<refs/원본 공고.pdf#page=3>)');
 const out=join(root,'out');convert(input,out);const md=readFileSync(join(out,'doc.md'),'utf8');
 assert.match(md,/###### 각주 1\n\n설명 !\[Source\]\(<attachments\/pdf-pages\//);
 assert.doesNotMatch(md,/csync-pdf-pages:v1|### PDF 원문|\]\(#pdf-/);
 const tree=buildTreeRenderer(out,['doc.md']),doc=tree.docs['doc.md'];const rendered=tree.render('doc.md',doc.body,doc.title);
 assert.deepEqual(rendered.deadAnchors,[]);assert.equal(rendered.images.length,1);
 const back=join(root,'back');convert(out,back,'obsidian');
 assert.match(readFileSync(join(back,'doc.md'),'utf8'),/\[\^pdf\]: 설명 \[\[attachments\/files\/[^\]]+원본 공고.pdf#page=3\|Source\]\]/);
 const again=join(root,'again');convert(out,again);assert.equal(readdirSync(join(again,'attachments/files')).length,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('PDF.js renders the selected page pixels without any executable on PATH', async()=>{
 const {root,input}=setup();try{
 writeFileSync(join(input,'doc.md'),'# PDF\n\n[Page](<refs/원본 공고.pdf#page=3>)');
 const out=join(root,'out');
 execFileSync(process.execPath,[cli,'convert','--to','markdown','--base',input,'--out',out],{
  encoding:'utf8', env:{...process.env,PATH:'',Path:''},stdio:'pipe',
 });
 const {loadImage,createCanvas}=await import('@napi-rs/canvas');
 const dir=join(out,'attachments/pdf-pages');const image=await loadImage(join(dir,readdirSync(dir)[0]));
 assert.equal(image.width,445);assert.equal(image.height,445);
 const canvas=createCanvas(image.width,image.height);const context=canvas.getContext('2d');context.drawImage(image,0,0);
 assert.deepEqual([...context.getImageData(100,100,1,1).data],[0,0,255,255]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
