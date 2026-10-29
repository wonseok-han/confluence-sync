import { list, del } from '@vercel/blob';
export default {async fetch(request){
 if(!process.env.BLOB_READ_WRITE_TOKEN)return Response.json({removed:0});
 if(!process.env.CRON_SECRET||request.headers.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`)return new Response(null,{status:401});
 let cursor,removed=0;
 do{const page=await list({prefix:'csync-transfer/',limit:1000,cursor});for(const blob of page.blobs)if(Date.now()-new Date(blob.uploadedAt).getTime()>24*60*60_000){await del(blob.url);removed++;}cursor=page.hasMore?page.cursor:undefined;}while(cursor);
 return Response.json({removed});
}};
