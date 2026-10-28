import { tokenGuide } from './token-guide.js';
/** In-app guide for the local document workflow. */
export const helpDialog = `
<dialog id="help-dialog" class="help-dialog" aria-labelledby="help-title">
  <header class="help-heading"><div><span class="eyebrow">WORKSPACE GUIDE</span><h2 id="help-title">사용 도움말</h2></div><form method="dialog"><button aria-label="도움말 닫기" autofocus>닫기</button></form></header>
  <nav class="help-nav" aria-label="도움말 목차"><a href="#help-convert">문서 변환</a><a href="#help-sync">Confluence</a><a href="#help-token">API 토큰 발급</a><a href="#help-links">참조 링크</a><a href="#help-faq">자주 묻는 질문</a></nav>
  <div class="help-body" tabindex="0" aria-label="사용 도움말 내용">
    <p class="help-intro">Obsidian에서 작업한 문서를 변환한 다음, 변환 결과 폴더를 기준으로 Confluence에 올릴 수 있습니다. 두 탭의 기준 폴더는 각각 설정합니다.</p>
    <section id="help-convert"><h3>문서 변환</h3>
      <ol><li><strong>기준 폴더 변경…</strong>으로 원본 폴더를 엽니다. 화살표는 폴더를 펼치고, 이름을 누르면 변환 대상을 선택합니다.</li><li>파일을 선택하고 기본적으로 접힌 <strong>문서 미리보기</strong>를 펼치면 표와 이미지를 포함한 본문이 표시됩니다. 파일 하나를 선택하면 그 파일만, 폴더를 선택하면 하위 Markdown 전체를 변환합니다.</li><li>변환 형식과 출력 폴더를 정하고 <strong>변환 미리보기</strong>로 원본과 결과를 비교합니다.</li><li><strong>변환 후 저장</strong>을 누른 뒤 <strong>결과 폴더 열기</strong>로 확인합니다. 웹 변환은 별도 출력 폴더에 저장하며, 첨부와 PDF 페이지 이미지는 각 문서 옆의 attachments/문서명/에 모읍니다.</li></ol>
      <dl><dt>Markdown</dt><dd>찾을 수 있는 위키링크를 상대 링크로 바꾸고 PDF 페이지 참조를 이미지로 변환합니다. 찾지 못한 문서 위키링크는 그대로 남습니다.</dd><dt>Obsidian</dt><dd>해석 가능한 Markdown 문서 링크를 위키링크로 바꿉니다.</dd><dt>Confluence 변환 오류 보정</dt><dd>옛 변환 결과의 CSS 잔해, 불필요한 이스케이프와 코드블록 언어 등을 보정합니다. 미리보기로 바뀐 내용을 확인하세요.</dd><dt>출력 위치</dt><dd>파일 하나는 출력 폴더 바로 아래에, 폴더 전체는 선택 폴더 내부 구조를 유지해 저장합니다. 출력 경로를 비우면 원본 기준 폴더 옆에 새 결과 폴더를 만듭니다.</dd></dl>
    </section>
    <section id="help-sync"><h3>Confluence: Push / Pull</h3>
      <p>01에서 스페이스 문서를 보관할 기준 폴더를 선택하고, .env 연결 설정에서 설정 확인 후 스페이스 연결을 누르세요. 별도 파일·폴더 스코프 설정은 없습니다.</p>
      <dl><dt>변경사항과 Fetch</dt><dd>로컬은 5초 간격으로 자동 확인하며 Confluence API를 호출하지 않습니다. Fetch는 스페이스 페이지를 100개씩 조회해 새 문서와 버전·위치 변경을 확인하고 2분 동안 결과를 재사용합니다. 문서와 동기화 기준은 유지합니다.</dd><dt>업로드(Push)</dt><dd>업로드할 문서를 체크하고 미리보기를 완료한 뒤 업로드하세요. 체크한 문서만 처리하며 원격 충돌 검사는 유지합니다. 선택 후 문서를 수정하면 최신 내용 반영과 미리보기가 다시 필요합니다.</dd><dt>가져오기(Pull)</dt><dd>변경 목록 위의 ‘원격 문서 n개 가져오기’로 원격 신규 문서와 원격에서만 바뀐 문서를 받습니다. 로컬이 비어 있어도 같은 기능을 사용합니다. 로컬 수정·의도적인 삭제·양쪽 변경은 보존하며 업로드 체크는 적용되지 않습니다. 문서 버전이 그대로인 첨부 단독 변경은 Fetch에서 감지하지 않습니다.</dd><dt>문서 복구·원복</dt><dd>각 문서 행에서 원격에서 복구 또는 원격으로 원복을 누르고 확인하세요. 원복은 해당 문서와 참조 첨부의 로컬 수정을 버립니다. 원격 문서는 변경하지 않으며 복구한 문서는 업로드 선택에서 제외됩니다.</dd><dt>왼쪽 문서 탐색</dt><dd>파일을 선택하면 문서를 미리볼 수 있습니다. 탐색 위치를 바꿔도 작업공간이나 업로드 선택은 바뀌지 않습니다. 제외 규칙과 독립된 하위 작업공간은 유지합니다.</dd><dt>설정 파일</dt><dd>기준 폴더의 .env 또는 직접 가져온 .env를 사용합니다. 가져온 값은 현재 웹 작업에만 적용되며 별도 저장 버튼으로 기준 폴더에 저장할 수 있습니다. 서버 실행 환경을 대신 사용하지 않습니다.</dd></dl>
      <p class="help-note">Pull은 원격 삭제를 로컬에 자동 반영하거나 양쪽 변경을 자동 병합하지 않습니다. 누락된 원격 첨부는 원격 참조를 유지하고 경고하며, 권한·네트워크 오류는 중단합니다. 기존 원격 루트 연결과 문서 매핑은 임의로 변경하지 않습니다.</p>
    </section>
    ${tokenGuide}
    <section id="help-links"><h3>다른 폴더의 문서와 연결하기</h3>
      <p>업로드할 문서는 프로젝트 폴더에 있고, 연결할 문서는 별도 DBP 폴더에 있다면 <strong>참조 문서 폴더</strong>에 DBP의 동기화 루트를 추가하세요. 여러 경로를 한 줄씩 입력하거나 폴더 선택창으로 추가할 수 있습니다.</p>
      <pre><code>[[원본/긴/경로/문서명|표시 이름]]
[표시 이름](../이전/문서명.md)</code></pre>
      <p>먼저 경로로 찾고, 찾지 못하면 기준·참조 폴더에서 파일명으로 찾습니다. 후보가 하나일 때만 연결하며 <code>|</code> 오른쪽은 화면에 표시할 이름입니다.</p>
      <ul><li>현재 루트의 문서는 그 문서의 페이지 제목으로 연결합니다. 파일명과 H1이 달라도 됩니다.</li><li>참조 문서는 <code>.csync/mapping.json</code>의 게시된 페이지 ID로 연결합니다. 참조 문서 자체는 업로드하지 않습니다.</li><li>같은 Confluence 서버의 별도 동기화 폴더를 지정하세요. 중복 파일명, 문서 누락, 게시 매핑 누락은 경고로 표시합니다.</li></ul>
      <p class="help-note">링크 경고가 있어도 업로드할 수 있습니다. 해결하지 못한 링크는 원문으로 남으므로 실행 전에 경고를 확인하세요.</p>
    </section>
    <section id="help-faq"><h3>자주 묻는 질문</h3>
      <details><summary>표 너비를 화면에서 조절할 수 있나요?</summary><p>문서를 선택하고 문서 미리보기의 표 서식 편집을 누른 뒤 표를 클릭하세요. 내용에 맞춤으로 글자 길이에 따라 자동 배분하거나, 열 경계 드래그·균등 배분·전체 너비를 조절한 뒤, 변경 비교에서 원본 파일에 저장합니다. 일반 Markdown 표는 HTML로 변환됩니다. 파일을 바꾸거나 새로고침하면 미저장 변경은 취소됩니다.</p></details>
      <details><summary>기존 파일이 있는데 덮어쓰기 확인창이 안 나와요.</summary><p>내용이 같으면 파일을 건드리지 않고 재사용합니다. 내용이 다른 경우에만 대상 목록을 보여주고 덮어쓸지 확인합니다. 취소하면 저장하지 않습니다.</p></details>
      <details><summary>문서를 검색했는데 나오지 않아요.</summary><p>검색은 선택한 기준 폴더의 모든 하위 Markdown 파일명을 대상으로 합니다. 본문은 검색하지 않으며 숨김 폴더·node_modules·attachments는 탐색과 검색에서 제외됩니다. 문서가 참조하는 첨부는 미리보기·변환·업로드에서 계속 사용합니다.</p></details>
      <details><summary>폴더를 변환했는데 비교 화면에 일부만 보여요.</summary><p>본문 비교는 최대 20개 문서, 문서당 200KB까지 지원합니다. 실제 저장은 선택 폴더의 전체 변환 대상에 적용됩니다.</p></details>
      <details><summary>실행 내역의 색은 무엇을 뜻하나요?</summary><p>초록은 신규·생성·완료, 황갈색은 변경·갱신, 보라는 참조·연결, 회색은 동일·재사용입니다. 주황 배경은 경고, 빨강 배경은 오류입니다. 함께 표시된 문구로 상세 내용을 확인하세요.</p></details>
      <details><summary>새로고침하면 설정이 사라지나요?</summary><p>기준 폴더, 출력 경로, 참조 폴더와 작업 옵션은 같은 브라우저에 저장됩니다. 브라우저 데이터를 지우거나 다른 주소·포트에서 열면 설정이 다를 수 있습니다. 업로드 승인은 저장하지 않으므로 다시 미리보기하세요.</p></details>
    </section>
  </div>
</dialog>`;
