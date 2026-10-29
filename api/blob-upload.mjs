import { handleUpload } from '@vercel/blob/client';
import { authorizeBlobUpload } from '../src/web/gateway.mjs';
export default {async fetch(request){
 if(request.method!=='POST')return new Response(null,{status:405});
 if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return new Response(null,{status:403});
 try{const body=await request.json();const result=await handleUpload({request,body,onBeforeGenerateToken:(path,payload)=>authorizeBlobUpload(path,payload),onUploadCompleted:async()=>{}});return Response.json(result,{headers:{'Cache-Control':'no-store'}});}
 catch{return Response.json({error:'첨부 전송을 준비하지 못했습니다. Private Blob 연결과 Confluence 인증을 확인하세요.'},{status:400});}
}};
