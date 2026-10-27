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
      <p>01의 <strong>기준 폴더</strong> 카드에 Push·Pull 대상 폴더와 전체 경로가 표시됩니다. 아래 문서 탐색으로 하위 폴더를 열어도 기준은 바뀌지 않습니다. 작업 범위는 파일 또는 폴더 스코프로 따로 저장합니다. <strong>기준 폴더로</strong> 버튼으로 돌아갈 수 있습니다. <strong>업로드(Push)</strong>는 로컬 → Confluence, <strong>가져오기(Pull)</strong>는 Confluence → 로컬입니다. 각각 직접 실행하며 자동 병합하지 않습니다.</p>
      <ol><li><strong>기준 폴더 변경…</strong>으로 업로드할 문서가 모인 폴더를 엽니다.</li><li><strong>설정 확인</strong>으로 서버·스페이스·저장된 스코프를 확인합니다. 01에서 파일·폴더를 선택하고 <strong>선택한 범위를 스코프로 저장</strong>을 누릅니다. 버튼은 01 문서 탐색 위의 스코프 영역에 있습니다. 전체는 트리의 <strong>기준 폴더 이름</strong>을 직접 선택합니다.</li><li><strong>업로드 미리보기</strong>에서 신규·변경 문서와 링크 경고를 확인합니다. 기본은 로컬 비교입니다. 원격 버전 확인을 선택하면 Confluence를 읽기 전용으로 조회합니다.</li><li><strong>Confluence에 업로드</strong>를 누르면 실제 업로드합니다. 문서나 설정을 바꾸면 다시 미리보기해야 합니다.</li></ol>
      <p><strong>가져오기(Pull)</strong>에서는 연결 설정과 저장된 작업 스코프를 확인하고 <strong>Confluence에서 가져오기</strong>를 누릅니다. Fetch 결과가 있으면 변경된 기존 문서만 받고 동일 버전의 본문·첨부 조회는 건너뜁니다. 만료된 결과는 배치로 갱신합니다. 새 원격 문서·첨부 변경까지 받으려면 <strong>스코프 전체 다시 탐색</strong>을 선택하세요. 최초 Pull은 전체를 탐색합니다. 파일 스코프는 그 문서 하나, 폴더 스코프는 하위 문서를 기존 매핑의 원래 위치로 내려받으며, 로컬 변경·이동 대기가 있으면 중단합니다. 로컬 문서 선택이나 참조 폴더는 Pull에 적용되지 않습니다. 원격 첨부가 없거나 404이면 원격 참조를 유지하고 나머지를 가져오며 완료(경고) 알림에 개수를 표시합니다. 권한·네트워크·서버 오류는 중단합니다.</p>
      <dl><dt>원격 변경 확인(Fetch)</dt><dd>저장된 스코프의 매핑된 페이지를 100개씩 묶어 메타데이터만 확인합니다. 2분 동안 캐시를 재사용하며 조회 시각·요청 횟수·결과를 03 실행 내역에 표시합니다. 문서·동기화 기준은 변경하지 않고 새 원격 문서·폴더·첨부 단독 변경은 검사하지 않습니다. 업로드 전 미리보기는 별도로 필요합니다.</dd><dt>작업 대상</dt><dd>기준 폴더는 스페이스 루트와 연결합니다. Push·Pull은 저장된 로컬 스코프 안의 문서만 처리하며 범위 밖 문서와 매핑은 유지합니다. 제외 규칙과 독립된 하위 작업공간은 적용됩니다.</dd><dt>왼쪽 문서 선택</dt><dd>문서를 미리보기하거나 작업 스코프 후보로 사용할 수 있습니다. 선택만으로 범위는 바뀌지 않으며 스코프로 저장해야 적용됩니다. 파일 하나를 저장하면 그 문서만 업로드합니다.</dd><dt>설정 파일</dt><dd>기준 폴더의 <code>.env</code> 사용 또는 파일 선택으로 <code>.env</code> 가져오기 중 하나를 선택합니다. 가져온 값은 현재 웹 작업에만 적용되며, 별도 저장 버튼으로 기준 폴더에 저장할 수 있습니다. 기존 파일은 교체 확인을 받습니다. 서버 실행 환경을 대신 사용하지 않습니다.</dd></dl>
      <p class="help-note">스코프 저장은 로컬 경로만 검증합니다. 최초 연결 때만 스페이스 홈페이지를 조회하며 기존 매핑을 전수 조회하거나 원격 부모 위치를 변경하지 않습니다. 처음 빈 폴더에는 /로 전체 Pull한 뒤 부분 범위를 선택하세요. 이전 원격 연결 스코프는 새 작업 범위를 다시 선택해야 합니다.</p>
      <p class="help-note">원격 확인을 선택하지 않은 미리보기는 서버의 권한이나 원격 버전을 검증하지 않습니다. 실행 시에는 변경 문서의 원격 버전 충돌을 검사합니다. 실행 중 일부 문서가 실패하면 로그를 확인하고 다시 미리보기하세요.</p>
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
