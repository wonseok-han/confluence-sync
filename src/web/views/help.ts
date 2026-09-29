/** In-app guide for the local document workflow. */
export const helpDialog = `
<dialog id="help-dialog" class="help-dialog" aria-labelledby="help-title">
  <header class="help-heading"><div><span class="eyebrow">WORKSPACE GUIDE</span><h2 id="help-title">사용 도움말</h2></div><form method="dialog"><button aria-label="도움말 닫기" autofocus>닫기</button></form></header>
  <nav class="help-nav" aria-label="도움말 목차"><a href="#help-convert">문서 변환</a><a href="#help-sync">동기화</a><a href="#help-links">참조 링크</a><a href="#help-faq">자주 묻는 질문</a></nav>
  <div class="help-body" tabindex="0" aria-label="사용 도움말 내용">
    <p class="help-intro">Obsidian에서 작업한 문서를 변환한 다음, 변환 결과 폴더를 기준으로 Confluence에 올릴 수 있습니다. 두 탭의 기준 폴더는 각각 설정합니다.</p>
    <section id="help-convert"><h3>문서 변환</h3>
      <ol><li><strong>변환 폴더 선택…</strong>으로 원본 폴더를 엽니다. 화살표는 폴더를 펼치고, 이름을 누르면 변환 대상을 선택합니다.</li><li>파일 하나를 선택하면 그 파일만, 폴더를 선택하면 하위 Markdown 전체를 변환합니다.</li><li>변환 형식과 출력 폴더를 정하고 <strong>미리보기</strong>로 원본과 결과를 비교합니다.</li><li><strong>변환 후 저장</strong>을 누른 뒤 <strong>결과 폴더 열기</strong>로 확인합니다. 웹 변환은 별도 출력 폴더에 저장합니다.</li></ol>
      <dl><dt>Markdown</dt><dd>찾을 수 있는 위키링크를 상대 링크로 바꾸고 PDF 페이지 참조를 이미지로 변환합니다. 찾지 못한 문서 위키링크는 그대로 남습니다.</dd><dt>Obsidian</dt><dd>해석 가능한 Markdown 문서 링크를 위키링크로 바꿉니다.</dd><dt>Confluence 변환 오류 보정</dt><dd>옛 변환 결과의 CSS 잔해, 불필요한 이스케이프와 코드블록 언어 등을 보정합니다. 미리보기로 바뀐 내용을 확인하세요.</dd><dt>출력 위치</dt><dd>파일 하나는 출력 폴더 바로 아래에, 폴더 전체는 선택 폴더 내부 구조를 유지해 저장합니다. 출력 경로를 비우면 원본 기준 폴더 옆에 새 결과 폴더를 만듭니다.</dd></dl>
    </section>
    <section id="help-sync"><h3>Confluence 동기화</h3>
      <ol><li><strong>동기화 폴더 선택…</strong>으로 업로드할 문서가 모인 폴더를 엽니다.</li><li>범위를 고르고 <strong>설정 확인</strong>으로 서버·스페이스·상위 페이지를 확인합니다.</li><li><strong>동기화 미리보기</strong>에서 신규·변경 문서와 링크 경고를 확인합니다. 이 단계는 로컬 비교이며 Confluence에 접속하지 않습니다.</li><li><strong>Confluence에 동기화</strong>를 누르면 실제 업로드합니다. 문서나 설정을 바꾸면 다시 미리보기해야 합니다.</li></ol>
      <dl><dt>선택 문서</dt><dd>왼쪽에서 선택한 Markdown 문서입니다.</dd><dt>현재 폴더</dt><dd>현재 탐색 중인 폴더와 그 하위 문서입니다. 상위 페이지를 연결하기 위한 처리가 함께 수행될 수 있습니다.</dd><dt>기준 폴더 전체</dt><dd>설정한 동기화 루트의 모든 하위 Markdown입니다. 제외 규칙에 해당하는 문서는 빠집니다.</dd><dt>설정 파일</dt><dd>비우면 기준 폴더의 <code>.env</code>를 사용하고, 없으면 웹 서버 실행 환경을 사용합니다. 다른 설정 파일을 직접 지정할 수도 있습니다.</dd></dl>
      <p class="help-note">미리보기는 서버의 권한이나 페이지 존재를 검증하지 않습니다. 실행 중 일부 문서가 실패하면 로그를 확인하고 다시 미리보기하세요.</p>
    </section>
    <section id="help-links"><h3>다른 폴더의 문서와 연결하기</h3>
      <p>업로드할 문서는 프로젝트 폴더에 있고, 연결할 문서는 별도 DBP 폴더에 있다면 <strong>참조 문서 폴더</strong>에 DBP의 동기화 루트를 추가하세요. 여러 경로를 한 줄씩 입력하거나 폴더 선택창으로 추가할 수 있습니다.</p>
      <pre><code>[[원본/긴/경로/문서명|표시 이름]]
[표시 이름](../이전/문서명.md)</code></pre>
      <p>먼저 경로로 찾고, 찾지 못하면 기준·참조 폴더에서 파일명으로 찾습니다. 후보가 하나일 때만 연결하며 <code>|</code> 오른쪽은 화면에 표시할 이름입니다.</p>
      <ul><li>현재 루트의 문서는 그 문서의 페이지 제목으로 연결합니다. 파일명과 H1이 달라도 됩니다.</li><li>참조 문서는 <code>.confluence-sync.json</code>의 게시된 페이지 ID로 연결합니다. 참조 문서 자체는 업로드하지 않습니다.</li><li>같은 Confluence 서버의 별도 동기화 폴더를 지정하세요. 중복 파일명, 문서 누락, 게시 매핑 누락은 경고로 표시합니다.</li></ul>
      <p class="help-note">링크 경고가 있어도 업로드할 수 있습니다. 해결하지 못한 링크는 원문으로 남으므로 실행 전에 경고를 확인하세요.</p>
    </section>
    <section id="help-faq"><h3>자주 묻는 질문</h3>
      <details><summary>기존 파일이 있는데 덮어쓰기 확인창이 안 나와요.</summary><p>내용이 같으면 파일을 건드리지 않고 재사용합니다. 내용이 다른 경우에만 대상 목록을 보여주고 덮어쓸지 확인합니다. 취소하면 저장하지 않습니다.</p></details>
      <details><summary>문서를 검색했는데 나오지 않아요.</summary><p>검색은 선택한 기준 폴더의 모든 하위 Markdown 파일명을 대상으로 합니다. 본문은 검색하지 않으며 숨김 폴더와 node_modules는 제외됩니다.</p></details>
      <details><summary>폴더를 변환했는데 비교 화면에 일부만 보여요.</summary><p>본문 비교는 최대 20개 문서, 문서당 200KB까지 지원합니다. 실제 저장은 선택 폴더의 전체 변환 대상에 적용됩니다.</p></details>
      <details><summary>실행 내역의 색은 무엇을 뜻하나요?</summary><p>초록은 신규·생성·완료, 황갈색은 변경·갱신, 보라는 참조·연결, 회색은 동일·재사용입니다. 주황 배경은 경고, 빨강 배경은 오류입니다. 함께 표시된 문구로 상세 내용을 확인하세요.</p></details>
      <details><summary>새로고침하면 설정이 사라지나요?</summary><p>기준 폴더, 출력 경로, 참조 폴더와 작업 옵션은 같은 브라우저에 저장됩니다. 브라우저 데이터를 지우거나 다른 주소·포트에서 열면 설정이 다를 수 있습니다. 업로드 승인은 저장하지 않으므로 다시 미리보기하세요.</p></details>
    </section>
  </div>
</dialog>`;
