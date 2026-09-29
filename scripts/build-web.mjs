import { build } from 'esbuild';
import { rm, copyFile } from 'node:fs/promises';
await rm(new URL('../dist/web/assets/', import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: {
    app: 'src/web/client/app.js',
    'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
  },
  outdir: 'dist/web/assets', bundle: true, format: 'esm', minify: true,
  loader: { '.ttf': 'file' }, assetNames: '[name]-[hash]', logLevel: 'info',
});

await copyFile('node_modules/monaco-editor/LICENSE', 'dist/web/assets/Monaco-LICENSE.txt');
await copyFile('node_modules/monaco-editor/ThirdPartyNotices.txt', 'dist/web/assets/Monaco-ThirdPartyNotices.txt');
