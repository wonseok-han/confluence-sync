/** Public UI only: no server, credentials or workspace files in the output. */
import {mkdir,cp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {webPage} from '../dist/web/views/workspace.js';
import {tableEditorBridge} from '../dist/web/table-editor-script.js';
await rm('dist/site',{recursive:true,force:true});
await mkdir('dist/site',{recursive:true});
await cp('dist/web/assets','dist/site/assets',{recursive:true});
// srcdoc inherits the parent policy. Permit only the exact bundled table bridge.
const hash=createHash('sha256').update(`(${tableEditorBridge.toString()})()`).digest('base64');
const policy=`default-src 'self'; script-src 'self' 'sha256-${hash}'; connect-src 'self' http://127.0.0.1:* http://localhost:* http://[::1]:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`;
await writeFile('dist/site/index.html',webPage('').replace('<meta name="viewport"',`<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><meta name="viewport"`));
