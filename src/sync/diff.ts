/** Compare local Markdown with a saved baseline, or explicitly requested remote body. */
import {bold, cyan, red, green, dim} from '../shared/colors.js';
import {readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {readBaseline} from './baseline.js';
import {loadMapping} from './mapping.js';
import {mappingPath} from './metadata.js';
import {loadWorkspace,requireScope,inScope,inNestedWorkspace,scopePath,assertWorkspaceConnection,resolveSyncBase} from './workspace.js';
import {buildIgnorer} from './ignore.js';
import {scopeClient} from './scope.js';
import {readEnv,type Env} from '../confluence/config.js';
import {htmlToMarkdown,codeLanguagesFromStorage} from '../documents/html-to-markdown.js';
import {splitFrontmatter} from '../documents/obsidian.js';
import {positionalArgs} from '../cli/args.js';
export async function documentDiff(base:string,input:string,options:{remote?:boolean;env?:Env}={}) {
  const workspace=loadWorkspace(base);requireScope(workspace);
  const path=scopePath(base,input);
  if(!/\.md$/i.test(path)||!inScope(path,workspace)||inNestedWorkspace(base,path)||buildIgnorer(base,[]).ignores(path))throw new Error('작업공간 안의 Markdown 문서를 선택하세요.');
  const file=resolve(base,path);
  if(!statSync(file).isFile()||statSync(file).size>2_000_000)throw new Error('비교할 문서는 2MB 이하 일반 파일이어야 합니다.');
  const after=readFileSync(file,'utf8'),mapping=loadMapping(mappingPath(base));
  const pageId=splitFrontmatter(after).data.pageId;
  const entry=mapping[path]??Object.values(mapping).find(e=>e.pageId===String(pageId));
  if(options.remote) {
    if(!entry?.pageId)return {path,before:'',after,source:'new',canRemote:false,note:'원격 연결이 없는 새 문서입니다. 전체 내용이 추가로 표시됩니다.'};
    const env=options.env??readEnv(base);assertWorkspaceConnection(workspace,env);
    const node=await scopeClient(env).getNode(entry.pageId);
    if(String(node.id)!==entry.pageId||node.type!=='page')throw new Error('연결된 원격 페이지를 확인하세요.');
    const localBody = splitFrontmatter(after).body;
    // buildFrontmatter adds one blank separator. Keep intentional body whitespace.
    const comparisonBody = localBody !== after ? localBody.replace(/^\r?\n/, '') : localBody;
    return {path,before:htmlToMarkdown(node.html,{obsidian:/^ {0,3}(?:> ?)+\[![\w-]+\]|\[\^[^\]\s]+\]:|(?<!\\)\^\[/m.test(comparisonBody),pageId:entry.pageId,storage:node.storage,codeLangs:codeLanguagesFromStorage(node.storage)}),after:comparisonBody,
      source:'remote',canRemote:true,note:`현재 원격 v${node.version??'?'} → 로컬 본문 비교입니다. 원격 HTML의 근사 변환이며 frontmatter는 제외합니다. 과거 동기화 기준과의 비교는 아닙니다. 변경 목록에는 본문 외 제목·원격 위치 변경도 포함됩니다.`};
  }
  if(entry?.sourceObject)return {path,before:readBaseline(base,entry.sourceObject),after,source:'baseline',canRemote:true,note:'마지막 Pull·Push 성공 시 저장한 Markdown → 현재 로컬 문서입니다. 첨부 파일의 바이트 차이는 본문 diff에 표시하지 않습니다.'};
  if(!entry)return {path,before:'',after,source:'new',canRemote:false,note:'새 문서입니다. 전체 내용이 추가로 표시됩니다.'};
  return {path,before:null,after,source:'unavailable',canRemote:true,note:'이 문서의 과거 본문은 저장되어 있지 않아 해시만으로 diff를 복원할 수 없습니다. 원격과 비교를 누르면 해당 페이지 본문만 1회 조회합니다. 이후 Pull·Push 성공부터 로컬 기준본이 저장됩니다.'};
}
/** A valid unified diff with one containing hunk; the web editor provides fine-grained changes. */
export function formatDocumentDiff(before:string,after:string,path:string) {
  if(before===after)return '본문 변경 없음\n';
  const lines=(text:string)=>(text.match(/[^\n]*(?:\n|$)/g)??[]).filter(Boolean);
  const a=lines(before),b=lines(after);let start=0,end=0;
  while(start<a.length&&start<b.length&&a[start]===b[start])start++;
  while(end<a.length-start&&end<b.length-start&&a[a.length-1-end]===b[b.length-1-end])end++;
  const display=(line:string,prefix:string)=>[prefix+line.replace(/\n$/,''),...(!line.endsWith('\n')?['\\ No newline at end of file']:[])];
  const aCount=a.length-start-end,bCount=b.length-start-end;
  return [`--- 기준/${path}`,`+++ 로컬/${path}`,`@@ -${aCount?start+1:start},${aCount} +${bCount?start+1:start},${bCount} @@`,...a.slice(start,a.length-end).flatMap(s=>display(s,'-')),...b.slice(start,b.length-end).flatMap(s=>display(s,'+'))].join('\n')+'\n';
}
export async function runDiff(argv:string[]) {
  const at=argv.indexOf('--base'),base=resolveSyncBase(at<0?undefined:argv[at+1]),paths=positionalArgs(argv).slice(1);
  if(!base||paths.length!==1)throw new Error('csync diff <파일> [--base <dir>] [--remote]');
  const result=await documentDiff(base,paths[0],{remote:argv.includes('--remote')});
  console.log(dim(result.note));
  if(result.before!==null)console.log(formatDocumentDiff(result.before,result.after,result.path).split('\n').map(line => {
    if(line.startsWith('--- ') || line.startsWith('+++ '))return bold(line);
    if(line.startsWith('@@'))return cyan(line);
    if(line.startsWith('-'))return red(line);
    if(line.startsWith('+') || line === '본문 변경 없음')return green(line);
    return line;
  }).join('\n'));
}
