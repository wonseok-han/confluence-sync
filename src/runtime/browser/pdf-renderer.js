import { readFileSync, existsSync, mkdirSync, writeFileSync } from './filesystem.js';
import { dirname } from 'path-browserify';
/** PDF.js uses DOM font/filter APIs. Delegate canvas rendering to the browser UI,
 * while selection, paths and generated-attachment naming stay in the shared engine.
 */
export async function renderPdfPages(jobs,dryRun){
 const grouped=new Map();for(const job of jobs){if(!grouped.has(job.file))grouped.set(job.file,[]);if(dryRun||!existsSync(job.target))grouped.get(job.file).push(job);}
 for(const [file,pages] of grouped){if(!pages.length)continue;
  try{const results=await globalThis.csyncRenderPdf({bytes:new Uint8Array(readFileSync(file)),pages:pages.map(job=>job.page),dryRun});
   if(!dryRun)for(let i=0;i<pages.length;i++){mkdirSync(dirname(pages[i].target),{recursive:true});writeFileSync(pages[i].target,new Uint8Array(results[i]));}
  }catch(error){throw Error(`PDF 이미지 변환 실패 (${file}): ${error.message}`);}
 }
}
