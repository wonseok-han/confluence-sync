import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {npmEnvironment} from '../scripts/npm-environment.mjs';

test('Vercel install removes only the obsolete npm cache-dir environment option',()=>{
 const source={PATH:'/bin',npm_config_cache_dir:'/old',NPM_CONFIG_CACHE_DIR:'/other',npm_config_cache:'/supported',NODE_ENV:'production'};
 assert.deepEqual(npmEnvironment(source),{PATH:'/bin',npm_config_cache:'/supported',NODE_ENV:'production'});
 assert.equal(source.npm_config_cache_dir,'/old');
});
test('initial web entry excludes Monaco and PDF.js; deferred modules remain loadable chunks',async()=>{
 const result=await build({entryPoints:{app:'src/web/client/app.js','editor.worker':'node_modules/monaco-editor/esm/vs/editor/editor.worker.js'},outdir:'dist/web/assets',bundle:true,format:'esm',splitting:true,minify:true,write:false,metafile:true,loader:{'.ttf':'file'},chunkNames:'chunks/[name]-[hash]'});
 const outputs=result.metafile.outputs,initial=new Set();
 function collect(path){if(initial.has(path))return;initial.add(path);for(const item of outputs[path].imports)if(item.kind==='import-statement')collect(item.path);}
 collect('dist/web/assets/app.js');
 const eagerInputs=[...initial].flatMap(path=>Object.keys(outputs[path].inputs));
 assert.equal(eagerInputs.some(path=>/node_modules\/(?:monaco-editor|pdfjs-dist)\//.test(path)),false);
 assert.ok([...initial].reduce((total,path)=>total+outputs[path].bytes,0)<150_000);
 assert.ok(Object.values(outputs).some(out=>out.entryPoint==='src/web/client/monaco.js'));
 assert.ok(Object.values(outputs).some(out=>out.entryPoint==='node_modules/pdfjs-dist/build/pdf.mjs'));
});
