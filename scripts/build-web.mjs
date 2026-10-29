import { build } from 'esbuild';
import { rm, copyFile, cp } from 'node:fs/promises';
import {readFile} from 'node:fs/promises';
import {browserPlatform} from './browser-platform.mjs';
import {tableEditorBridge} from '../dist/web/table-editor-script.js';
await rm(new URL('../dist/web/assets/', import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: {
    app: 'src/web/client/app.js',
    'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
  },
  outdir: 'dist/web/assets', bundle: true, format: 'esm', minify: true, splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  loader: { '.ttf': 'file' }, assetNames: '[name]-[hash]', logLevel: 'info',
});

const {version}=JSON.parse(await readFile('package.json','utf8'));
await build({entryPoints:['src/runtime/browser/worker.js'],outfile:'dist/web/assets/workspace.worker.js',bundle:true,format:'esm',platform:'browser',minify:true,
  inject:['src/runtime/browser/globals.js'],plugins:[browserPlatform()],
  define:{__CSYNC_VERSION__:JSON.stringify(version),__CSYNC_TABLE_BRIDGE__:JSON.stringify(tableEditorBridge.toString())},logLevel:'info'});
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs','dist/web/assets/pdf.worker.min.mjs');
await copyFile('node_modules/pdfjs-dist/LICENSE','dist/web/assets/PDFJS-LICENSE.txt');
for(const folder of ['cmaps','standard_fonts','wasm'])await cp('node_modules/pdfjs-dist/'+folder,'dist/web/assets/pdf/'+folder,{recursive:true});

await copyFile('node_modules/monaco-editor/LICENSE', 'dist/web/assets/Monaco-LICENSE.txt');
await copyFile('node_modules/monaco-editor/ThirdPartyNotices.txt', 'dist/web/assets/Monaco-ThirdPartyNotices.txt');

// Guide screenshots include click annotations and account redaction.
await cp(new URL('../docs/images/guide/', import.meta.url), new URL('../dist/web/assets/guide/', import.meta.url), { recursive: true });

await copyFile('src/web/assets/favicon.svg', 'dist/web/assets/favicon.svg');

// Ship only the blank, public example; never copy the workspace .env.
await copyFile('.env.example', 'dist/web/assets/confluence-env-example.txt');
