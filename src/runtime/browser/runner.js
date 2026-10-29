import { process } from './globals.js';
import { runPush } from '../../sync/push.js';
import { runPull } from '../../sync/pull.js';
import { runFetch } from '../../sync/fetch.js';
import { runRestore } from '../../sync/restore.js';
import { runConvert } from '../../conversion/convert.js';

async function capture(args,env,log,task){
 const before=process.env,methods=['log','error','warn','info'],originals=methods.map(m=>console[m]);
 process.env={NO_COLOR:'1',...env};process.argv=args;process.exitCode=0;
 for(const method of methods)console[method]=(...values)=>log(values.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' ')+'\n');
 try{await task();return process.exitCode??0;}finally{process.env=before;methods.forEach((m,i)=>{console[m]=originals[i];});}
}
export const runSyncCLI=async(args,env,log)=>{
 const commands={push:runPush,pull:runPull,fetch:runFetch,restore:runRestore};
 if(!commands[args[0]])throw Error('지원하지 않는 브라우저 명령입니다.');
 return capture(args,env,log,()=>commands[args[0]](args[0]==='push'?args.slice(1):args));
};
export async function convert(args){let stdout='';const code=await capture(args,{},text=>{stdout+=text;},()=>runConvert(['convert',...args]));if(code)throw Error(stdout||'문서 변환에 실패했습니다.');return {stdout};}
