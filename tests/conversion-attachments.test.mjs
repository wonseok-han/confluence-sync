import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {runConvert} from '../dist/conversion/convert.js';
import {workspace} from './helpers/fixtures.mjs';

for(const fix of [false,true])test(`conversion copies PPTX with escaped brackets in its link label, fix=${fix}`,async t=>{
 const name='[특허 컨셉 Paper] 발표 v0.1.pptx';
 const original=`# Paper\n\n| 첨부 | 파일 |\n| --- | --- |\n| PPT | [\\[특허 컨셉 Paper\\] 발표](<참고자료/%5B특허 컨셉 Paper%5D 발표 v0.1.pptx>) |\n`;
 const bytes=Buffer.from([0x50,0x4b,3,4,0,255]);
 const {root}=workspace(t,{'vault/008_Paper.md':original,[`vault/참고자료/${name}`]:bytes});
 await runConvert(['convert','--to','markdown','--base',join(root,'vault'),'--out',join(root,'out'),...(fix?['--fix']:[]),join(root,'vault/008_Paper.md')]);
 const result=readFileSync(join(root,'out/008_Paper.md'),'utf8');
 assert.match(result,/\]\(<attachments\/008_Paper\//);
 assert.deepEqual(readFileSync(join(root,'out/attachments/008_Paper',name)),bytes);
 assert.equal(readFileSync(join(root,'vault/008_Paper.md'),'utf8'),original);
});
