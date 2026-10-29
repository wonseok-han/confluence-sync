/** Stateless, Cloud-only Confluence bridge. It never reads a local workspace or stores credentials. */
import { createHash } from 'node:crypto';
import { get, del } from '@vercel/blob';
const MAX_UPLOAD=105*1024*1024;
export const transferPrefix=(authorization,target)=>'csync-transfer/'+createHash('sha256').update(authorization+'\n'+target).digest('hex')+'/';
export function cloudTarget(value){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||/%(?:2f|5c|00)/i.test(url.pathname))throw Error('Atlassian Cloud HTTPS 주소만 지원합니다.');
 const path=url.hostname==='api.atlassian.com'?url.pathname.replace(/^\/ex\/confluence\/[0-9a-f-]+(?=\/wiki\/)/i,''):url.hostname.endsWith('.atlassian.net')?url.pathname:'';
 if(!/^\/wiki\/(?:api\/v2\/|rest\/api\/|download\/attachments\/)/.test(path))throw Error('Confluence API 또는 첨부 경로만 사용할 수 있습니다.');
 return url;
}
const json=(status,error)=>Response.json({error},{status,headers:{'Cache-Control':'no-store'}});
function sameOrigin(request){const origin=request.headers.get('origin');return !origin||origin===new URL(request.url).origin;}
function credentials(value){if(!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(value??''))throw Error('Confluence 연결 인증이 필요합니다.');return value;}
function writeTarget(url){return /(?:\/api\/v2\/(?:pages|folders)(?:\/\d+)?|\/rest\/api\/content\/\d+\/child\/attachment(?:\/\d+\/data)?)$/.test(url.pathname);}
export function createConfluenceGateway({fetch=globalThis.fetch,readBlob=get,deleteBlob=del}={}){
 return async request=>{
  if(request.method!=='POST')return json(405,'POST 요청만 지원합니다.');
  if(!sameOrigin(request))return json(403,'같은 웹 화면에서 요청하세요.');
  let temporary;
  try{
   const target=cloudTarget(request.headers.get('x-csync-target')),authorization=credentials(request.headers.get('authorization'));
   const method=request.headers.get('x-csync-method');if(!['GET','POST','PUT'].includes(method))throw Error('지원하지 않는 Confluence 요청입니다. 원격 삭제는 제공하지 않습니다.');
   const headers={Authorization:authorization};for(const name of ['content-type','accept','x-atlassian-token'])if(request.headers.has(name))headers[name]=request.headers.get(name);
   let body;
   const upload=request.headers.get('x-csync-upload');
   if(upload){
    if(!['POST','PUT'].includes(method)||!writeTarget(target))throw Error('업로드 경로를 확인하세요.');
    const blobUrl=new URL(upload),prefix=transferPrefix(authorization,target.href);
    if(blobUrl.protocol!=='https:'||!blobUrl.hostname.endsWith('.private.blob.vercel-storage.com')||!decodeURIComponent(blobUrl.pathname).startsWith('/'+prefix))throw Error('이 연결에서 준비한 첨부만 사용할 수 있습니다.');
    const blob=await readBlob(upload,{access:'private',useCache:false});if(!blob||blob.statusCode!==200)throw Error('임시 첨부가 만료되었습니다. 다시 시도하세요.');temporary=upload;
    const length=Number(blob.blob?.size);if(!Number.isSafeInteger(length)||length<0||length>MAX_UPLOAD)throw Error('업로드 크기 한도를 초과했습니다.');body=blob.stream;
   }else if(!['GET','HEAD'].includes(method)){
    const bytes=new Uint8Array(await request.arrayBuffer());if(bytes.length>3*1024*1024)return json(413,'큰 첨부는 Private Blob 전송 설정이 필요합니다.');body=bytes;
   }
   let url=target.href,response;
   for(let hop=0;hop<6;hop++){
    response=await fetch(url,{method,headers,body,redirect:'manual',signal:AbortSignal.any([request.signal,AbortSignal.timeout(120_000)]),...(body instanceof ReadableStream?{duplex:'half'}:{})});
    if(![301,302,303,307,308].includes(response.status))break;
    if(method!=='GET')throw Error('쓰기 요청의 리다이렉트는 허용하지 않습니다.');
    const next=new URL(response.headers.get('location'),url);
    if(next.protocol!=='https:'||next.port||next.username||next.password||!(next.hostname===target.hostname||next.hostname==='api.media.atlassian.com'||next.hostname.endsWith('.media.atlassian.com')||next.hostname.endsWith('.amazonaws.com')||next.hostname.endsWith('.cloudfront.net')))throw Error('허용되지 않은 첨부 리다이렉트입니다.');
    if(next.origin!==target.origin)delete headers.Authorization;url=next.href;
    await response.body?.cancel();if(hop===5)throw Error('첨부 리다이렉트가 너무 많습니다.');
   }
   const visible=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   for(const name of ['content-type','link','atl-traceid','x-arequestid','retry-after','x-ratelimit-remaining','x-ratelimit-reset'])if(response.headers.has(name))visible.set(name,response.headers.get(name));
   // Stream binary and metadata responses; never buffer a large download into a Function response.
   return new Response(response.body,{status:response.status,statusText:response.statusText,headers:visible});
  }catch(error){return json(400,'Confluence 중계에 실패했습니다. 연결 주소·권한·첨부 전송 설정을 확인하세요.');}
  finally{if(temporary)await deleteBlob(temporary).catch(()=>{});}
 };
}

export async function authorizeBlobUpload(pathname,payload,{fetch=globalThis.fetch}={}){
 const {target:address,authorization}=JSON.parse(payload??'{}'),target=cloudTarget(address);credentials(authorization);
 if(!writeTarget(target)||!pathname.startsWith(transferPrefix(authorization,target.href))||!/^[a-f0-9-]{36}$/.test(pathname.split('/').at(-1)))throw Error('업로드 요청을 확인하세요.');
 const prefix=target.pathname.slice(0,target.pathname.indexOf('/wiki/')+5);
 const probe=new URL(prefix+'/rest/api/content?limit=1',target.origin);
 const response=await fetch(probe,{headers:{Authorization:authorization},redirect:'error',signal:AbortSignal.timeout(15_000)});await response.body?.cancel();if(!response.ok)throw Error('Confluence 연결 인증에 실패했습니다.');
 return {maximumSizeInBytes:MAX_UPLOAD,validUntil:Date.now()+10*60_000,addRandomSuffix:false,allowOverwrite:false};
}
