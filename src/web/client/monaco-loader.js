let pending;
/** Share a single load across conversion, document formatting and remote diff. */
export function loadMonaco(){
 pending??=import('./monaco.js').catch(error=>{pending=undefined;throw Error('본문 비교 도구를 불러오지 못했습니다. 다시 시도하세요. '+error.message);});
 return pending;
}
