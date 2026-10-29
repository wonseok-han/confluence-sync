import { upload } from '@vercel/blob/client';
const LIMIT=3*1024*1024;
export async function transferPrefix(authorization,target){const bytes=new TextEncoder().encode(authorization+'\n'+target);const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));return 'csync-transfer/'+[...hash].map(b=>b.toString(16).padStart(2,'0')).join('')+'/';}
/** Only remote Confluence calls cross the network. Local engine calls stay in its worker. */
export function createConfluenceTransport({fetch,origin,uploadFile=upload}){
 return async(input,init={})=>{
  const request=input instanceof Request?new Request(input,init):new Request(new URL(String(input),origin),init);
  if(new URL(request.url).origin===origin)return fetch(request);
  const method=request.method,authorization=request.headers.get('authorization')??'';
  const headers={'X-Csync-Target':request.url,'X-Csync-Method':method,'Authorization':authorization};
  for(const name of ['content-type','x-atlassian-token','accept'])if(request.headers.has(name))headers[name]=request.headers.get(name);
  let body=['GET','HEAD'].includes(method)?undefined:await request.arrayBuffer();
  if(body?.byteLength>LIMIT){
   const prefix=await transferPrefix(authorization,request.url),pathname=prefix+crypto.randomUUID();
   const result=await uploadFile(pathname,new Blob([body],{type:request.headers.get('content-type')??'application/octet-stream'}),{access:'private',handleUploadUrl:origin+'/api/blob-upload',multipart:true,abortSignal:request.signal,clientPayload:JSON.stringify({target:request.url,authorization})});
   headers['X-Csync-Upload']=result.url;body=undefined;
  }
  return fetch(origin+'/api/confluence',{method:'POST',headers,body,signal:request.signal,credentials:'omit',redirect:'error'});
 };
}
