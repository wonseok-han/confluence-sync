/** Local recovery only. No cookies, credentials or workspace state are stored on Vercel. */
export async function sessionStore(id,value){
 if(typeof indexedDB==='undefined')return undefined;
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('csync.worker-sessions',1);r.onupgradeneeded=()=>r.result.createObjectStore('sessions');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction('sessions',value===undefined?'readonly':'readwrite'),store=tx.objectStore('sessions'),r=value===undefined?store.get(id):value===null?store.delete(id):store.put(value,id);let result;r.onsuccess=()=>{result=r.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);});}finally{db.close();}
}
