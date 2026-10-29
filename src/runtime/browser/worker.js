import { createStandaloneEngine } from './engine.js';
const request=createStandaloneEngine();
let pdfId=0;const pdfRequests=new Map();
globalThis.csyncRenderPdf=request=>new Promise((resolve,reject)=>{const id=++pdfId;pdfRequests.set(id,{resolve,reject});globalThis.postMessage({kind:'pdf',id,request},[request.bytes.buffer]);});
// Requests must be serialized, except job polling naturally interleaves with the
// async job started by createWebSync. This matches the existing web controller.
let queue=Promise.resolve();
globalThis.onmessage=({data})=>{if(data.kind==='pdf-result'){const item=pdfRequests.get(data.id);if(item){pdfRequests.delete(data.id);data.error?item.reject(Error(data.error)):item.resolve(data.pages);}return;}queue=queue.catch(()=>{}).then(async()=>{try{const result=await request(data);globalThis.postMessage({id:data.id,...result},result.body instanceof ArrayBuffer?[result.body]:[]);}catch(error){globalThis.postMessage({id:data.id,error:error.message});}});};
