/** Explicit browser I/O bindings for the shared Node CLI modules. */
import {resolve} from 'node:path';
export function browserPlatform(){
 const bindings={
  'node:fs':'src/runtime/browser/filesystem.js','fs':'src/runtime/browser/filesystem.js',
  'node:fs/promises':'src/runtime/browser/filesystem.js',
  'node:crypto':'src/runtime/browser/crypto.js','crypto':'src/runtime/browser/crypto.js',
  'node:os':'src/runtime/browser/os.js','os':'src/runtime/browser/os.js',
  'node:url':'src/runtime/browser/url.js',
 };
 return {name:'csync-browser-platform',setup(build){
  build.onResolve({filter:/^(node:)?(fs(\/promises)?|crypto|os|url)$/},args=>({path:resolve(bindings[args.path])}));
  build.onResolve({filter:/^(node:)?path$/},()=>({path:resolve('node_modules/path-browserify/index.js')}));
  // Workers have no DOM. Use Turndown's DOM-independent entry backed by Domino.
  build.onResolve({filter:/^turndown$/},()=>({path:resolve('node_modules/turndown/lib/turndown.es.js')}));
  build.onResolve({filter:/^@mixmark-io\/domino$/},()=>({path:resolve('node_modules/@mixmark-io/domino/lib/index.js')}));
  build.onResolve({filter:/\/pdf-renderer\.js$/},()=>({path:resolve('src/runtime/browser/pdf-renderer.js')}));
  build.onResolve({filter:/\/node-runner\.js$/},()=>({path:resolve('src/runtime/browser/runner.js')}));
  build.onResolve({filter:/\/shared\/progress\.js$/},()=>({path:resolve('src/runtime/browser/progress.js')}));
  build.onResolve({filter:/\/runtime\/network\.js$/},()=>({path:resolve('src/runtime/browser/network.js')}));
 }};
}
