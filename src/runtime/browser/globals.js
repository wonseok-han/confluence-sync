import { Buffer } from 'buffer';
// Buffer 6 has base64 but not Node's base64url spelling. Round-trip markers use both.
const stringify=Buffer.prototype.toString,from=Buffer.from;
Buffer.prototype.toString=function(encoding,...args){return encoding==='base64url'?stringify.call(this,'base64',...args).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''):stringify.call(this,encoding,...args);};
Buffer.from=function(value,encoding,...args){return from.call(Buffer,value,encoding==='base64url'?'base64':encoding,...args);};
export { Buffer };
let cwd='/';
export const process={env:{NO_COLOR:'1'},argv:[],platform:'browser',exitCode:0,cwd:()=>cwd,chdir:value=>{cwd=value;},stdout:{isTTY:false},stderr:{isTTY:false},exit(code){throw Error(`작업이 종료되었습니다 (${code}). 위 내역을 확인하세요.`);}};
