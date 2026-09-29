import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { publishOutput, OverwriteRequired } from '../dist/web/output.js';
import { workspace } from './helpers/fixtures.mjs';

test('failed export restores replaced documents and removes its backup', {skip:process.platform==='win32'||process.getuid?.()===0}, async t => {
 const {root}=workspace(t,{'stage/a.md':'new','stage/z/new.md':'new file','out/a.md':'old'});
 const output=join(root,'out');mkdirSync(join(output,'z'));chmodSync(join(output,'z'),0o555);
 try {
 let approval;
 try{await publishOutput(join(root,'stage'),output);}catch(error){assert.ok(error instanceof OverwriteRequired);approval=Object.fromEntries(error.conflicts.map(c=>[c.path,c.hash]));}
 assert.ok(approval);
 await assert.rejects(publishOutput(join(root,'stage'),output,approval),/EACCES|EPERM/);
 assert.equal(readFileSync(join(output,'a.md'),'utf8'),'old');
 assert.deepEqual(readdirSync(output).sort(),['a.md','z']);
 } finally {chmodSync(join(output,'z'),0o755);}
});
