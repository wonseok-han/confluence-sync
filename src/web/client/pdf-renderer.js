/** Browser canvas and fonts; no filesystem access and no server-side rendering. */
export async function renderBrowserPdf({bytes,pages,dryRun}){
 const {getDocument,GlobalWorkerOptions,VerbosityLevel}=await import('pdfjs-dist/build/pdf.mjs');
 GlobalWorkerOptions.workerSrc='/assets/pdf.worker.min.mjs';
 const task=getDocument({data:bytes,cMapUrl:'/assets/pdf/cmaps/',cMapPacked:true,standardFontDataUrl:'/assets/pdf/standard_fonts/',wasmUrl:'/assets/pdf/wasm/',useSystemFonts:false,verbosity:VerbosityLevel.ERRORS});
 try{const pdf=await task.promise;for(const page of pages)if(!Number.isInteger(page)||page<1||page>pdf.numPages)throw Error(`PDF 쪽 범위 초과: ${page} (총 ${pdf.numPages}쪽)`);if(dryRun)return [];
  const results=[];for(const number of pages){const page=await pdf.getPage(number),viewport=page.getViewport({scale:160/72}),canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
   try{await page.render({canvas,canvasContext:canvas.getContext('2d'),viewport}).promise;const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('PDF 이미지를 저장하지 못했습니다.')),'image/png'));results.push(await blob.arrayBuffer());}finally{page.cleanup();canvas.width=canvas.height=1;}
  }return results;
 }finally{await task.destroy();}
}
