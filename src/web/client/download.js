/** Download plain text locally; callers supply only public templates or masked logs. */
export function downloadText(filename, text) {
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
  const link=document.createElement('a');
  try {
    link.href=url;link.download=filename;document.body.append(link);link.click();
  } finally {
    link.remove();
    // The browser may consume the object URL after the click task completes.
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
}
const jobNames={preview:'업로드 미리보기',fetch:'원격 변경 확인',pull:'가져오기',push:'업로드',restore:'복구·원복'};
const states={running:'진행 중',succeeded:'완료',failed:'실패'};
const when=value=>value?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'-';
export function formatJobLog(job) {
  // Never serialize connection settings: job.log has already been masked by the server.
  return ['confluence-sync 실행 로그',`작업: ${jobNames[job.kind]??job.kind}`,`상태: ${states[job.state]??job.state}`,`작업 ID: ${job.id}`,`시작 (Asia/Seoul): ${when(job.startedAt)}`,`종료 (Asia/Seoul): ${when(job.finishedAt)}`,'',job.log??''].join('\n')+'\n';
}
export function jobLogFilename(job) {
  const kind=Object.hasOwn(jobNames,job.kind)?job.kind:'job';
  const id=String(job.id??'').replace(/[^a-zA-Z0-9-]/g,'').slice(0,36)||'current';
  return `csync-${kind}-${id}.log`;
}
