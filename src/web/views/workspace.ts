import { readPkgVersion } from '../../shared/version.js';
import { helpDialog } from './help.js';
import { syncPanel } from './sync-panel.js';
const formatIcon = (path: string) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
/** HTML shell; Monaco and application code are bundled as local assets. */
export const webPage = (token: string, runtime: 'local' | 'browser' | 'standalone' = 'local') => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="csync-token" content="${token}"><meta name="csync-runtime" content="${runtime}"><meta name="csync-version" content="${readPkgVersion()}"><title>문서 워크스페이스 · confluence-sync</title><link rel="icon" type="image/svg+xml" href="/assets/favicon.svg?v=paperlink"><link rel="stylesheet" href="/assets/app.css"></head><body>
<header class="app-header"><a class="brand" href="/" aria-label="confluence-sync 홈"><img class="brand-symbol" src="/assets/favicon.svg?v=paperlink" alt="" aria-hidden="true" width="30" height="30">confluence<span class="brand-light">sync</span></a><span class="app-version" aria-label="현재 버전">v${readPkgVersion()}</span><span class="local-status"><i></i><span id="local-connection-status">${runtime!=='local'?'브라우저 폴더 선택 필요':token ? '로컬 워크스페이스' : '로컬 실행기 연결 필요'}</span></span><button id="local-disconnect" class="quiet" type="button" hidden>연결 해제</button></header>
<main id="workspace-interface" class="app-main">
  <div class="page-heading"><div><div class="eyebrow">DOCUMENT WORKSPACE</div><h1>문서 워크스페이스<span class="title-dot">.</span></h1></div><div class="page-heading-actions"><p>문서를 변환하고, Confluence에서 가져오거나 업로드하세요.</p><button id="open-help" aria-haspopup="dialog" aria-controls="help-dialog">사용 도움말</button></div></div>
  <div class="mode-tabs" role="tablist" aria-label="문서 작업"><button id="tab-convert" role="tab" aria-selected="true" aria-controls="convert-view">문서 변환</button><button id="tab-sync" role="tab" aria-selected="false" aria-controls="sync-view" tabindex="-1">Confluence</button></div>
  <div class="workspace">
    <aside class="panel explorer" aria-label="파일 탐색">
      <div class="panel-heading"><h2>로컬 문서</h2><span id="count" class="count">폴더 탐색</span></div>
      <div class="folder-picker root-picker">
        <section class="workspace-root-card" aria-labelledby="root-heading">
          <div class="workspace-root-heading"><h3 id="root-heading">기준 폴더</h3><span id="root-purpose" class="root-purpose">변환 기준</span></div>
          <strong id="root-name" class="root-name">폴더를 선택하세요</strong>
          <p id="root-path" class="root-path">아직 설정되지 않았습니다.</p>
          <p id="root-hint" class="root-hint">문서와 참조 링크를 찾는 기준입니다.</p>
        </section>
        <button id="choose-base" class="folder-button"><span aria-hidden="true">↻</span>기준 폴더 변경…</button>
        <details id="root-path-editor" class="root-path-editor"><summary>경로를 직접 입력해 변경</summary><label for="base-input">새 기준 폴더 경로</label><input id="base-input" class="path-input" placeholder="폴더의 전체 경로"><button id="apply-base" type="button">이 폴더를 기준으로 설정</button></details>
      </div>
      <div class="explorer-navigation">
        <div class="explorer-nav-heading"><span>문서 탐색</span><button id="base-home" class="quiet" type="button" aria-label="기준 폴더로 돌아가기">기준 폴더로</button></div>
        <div class="explorer-nav-row"><button id="up" class="quiet" aria-label="상위 폴더" title="상위 폴더">↑</button><p id="path" class="path" aria-label="현재 탐색 위치"></p></div>
      </div>
      <div class="search-wrap"><span aria-hidden="true">⌕</span><input id="search" type="search" placeholder="하위 폴더까지 파일 이름 검색" aria-label="파일 이름 검색"></div>
      <div id="files" class="files"></div>
      <div class="explorer-footer"><span class="file-type">MD</span><span id="explorer-note">파일·폴더를 선택해 변환하세요</span></div>
    </aside>
    <div id="convert-view" class="workspace-content" role="tabpanel" aria-labelledby="tab-convert">
      <section id="document-preview-panel" class="panel document-preview" aria-label="문서 미리보기">
        <div class="panel-heading document-preview-heading"><h2><button id="document-preview-toggle" class="preview-disclosure" aria-expanded="false" aria-controls="document-preview-body"><span id="document-preview-chevron" aria-hidden="true">▸</span>문서 미리보기<span id="document-preview-toggle-label" class="preview-disclosure-label">펼치기</span></button></h2><div id="document-preview-actions" class="actions" hidden><button id="document-format-toggle" class="quiet format-entry" aria-expanded="false" aria-controls="document-format-controls" disabled>${formatIcon('M4 5h16M4 10h10M4 15h8m4-2 4 4m-5 3 5-5 2 2-5 5h-2v-2Z')}문서 서식 정리</button><button id="document-preview-refresh" class="quiet" title="문서를 다시 읽기" disabled>${formatIcon('M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1')}새로고침</button></div></div>
        <div id="document-preview-body" hidden>
        <p id="document-preview-status" class="document-preview-status" role="status" aria-live="polite">Markdown 파일을 선택하면 본문이 표시됩니다.</p>
        <div id="document-format-controls" class="document-format-controls" hidden>
          <div class="format-toolbar" role="group" aria-label="문서 서식 정리 도구">
            <div class="format-tool-group"><span class="format-group-label">문서</span><button id="document-format-basic" class="format-tool-button" title="제목·문단 간격, 목록 기호, 공백과 Markdown 표 정리 결과를 비교합니다" disabled>${formatIcon('M4 5h16M4 10h16M4 15h10M4 20h10')}기본 서식 정리</button></div>
            <div class="format-tool-group"><label class="format-group-label" for="document-format-tables">모든 표</label><select id="document-format-tables" title="문서 안의 모든 표 열 너비"><option value="keep">기존 너비 유지</option><option value="fit">내용에 맞춤</option><option value="equal">균등 배분</option></select><button id="table-edit-toggle" class="format-tool-button" aria-pressed="false" aria-controls="table-format-controls" disabled>${formatIcon('M3 4h18v16H3zM3 9h18M9 4v16M15 4v16')}표 직접 편집</button></div>
            <div class="format-toolbar-actions"><button id="table-revert-all" class="quiet" title="모든 표 너비 변경 취소" disabled>${formatIcon('M4 4v6h6M4 10a8 8 0 1 1 1 8')}표 변경 취소</button><button id="document-format-review" class="primary" disabled>${formatIcon('M9 4H4v16h5M15 4h5v16h-5M9 9l-3 3 3 3M15 9l3 3-3 3')}변경 비교</button></div>
          </div>
          <div id="table-format-controls" class="table-format-controls" hidden>
            <div class="format-context-heading"><span class="format-context-label">선택한 표</span><p id="table-format-status" role="status" aria-live="polite">미리보기에서 조절할 표를 클릭하세요.</p></div>
            <div class="table-format-actions"><label>표 너비 <input id="table-total-width" type="range" min="320" max="1200" step="1" disabled><output id="table-total-label"></output></label><div class="format-button-set"><button id="table-fit" title="선택한 표의 글자 길이에 맞춰 열 너비 배분" disabled>내용에 맞춤</button><button id="table-equal" disabled>균등 배분</button></div><button id="table-revert" class="quiet" disabled>선택 표 취소</button></div>
          </div>
          <div class="format-toolbar-footer"><span id="format-summary" role="status">변경 비교 후 원본 파일에 저장합니다.</span><details><summary>적용 범위</summary><p>기본 서식 정리를 누르면 정리 결과를 바로 비교합니다. 코드·링크 경로·HTML 표는 보존하며 저장 전에는 파일을 바꾸지 않습니다. 모든 표의 너비를 일괄 배분한 뒤 개별 표를 추가로 조절할 수 있습니다. 너비를 지정한 Markdown 표는 HTML로 바뀝니다. 비교창을 닫으면 저장하지 않습니다.</p></details></div>
        </div>
        <iframe id="document-preview-frame" class="document-preview-frame" title="선택한 Markdown 문서 미리보기" sandbox="allow-scripts" hidden></iframe>
        <p class="document-preview-note">로컬 문서 미리보기이며 Confluence의 실제 표시와 다를 수 있습니다.</p>
        </div>
      </section>
      <section class="panel settings" aria-label="변환 설정">
        <div class="panel-heading"><h2>변환 설정</h2><span id="convert-save-mode" class="subtle-label">별도 폴더 저장</span></div>
        <div class="settings-body">
          <div class="document-summary"><span class="document-symbol" aria-hidden="true">MD</span><div><div id="selected" class="selected-name">변환할 문서를 선택하세요</div><div id="base" class="base">왼쪽에서 폴더를 열어 시작하세요.</div></div></div>
          <div class="convert-target-actions"><button id="convert-select-all" type="button" disabled>기준 폴더 전체 선택</button><span id="convert-target-note" class="hint">파일·폴더를 선택하거나 기준 폴더 전체를 선택하세요.</span></div>
          <p id="convert-output-hint" class="hint"></p><div class="settings-grid"><div class="field"><label for="direction">변환 형식</label><select id="direction"><option value="markdown">Markdown</option><option value="obsidian">Obsidian</option><option value="repair">Confluence 오류 보정만</option></select></div><div class="field output-field"><label for="out-input">출력 폴더 <span id="out-mode-hint">선택 사항</span></label><div class="path-row"><input id="out-input" class="path-input" placeholder="자동으로 새 폴더 생성"><button id="choose-out">폴더 선택…</button></div></div></div>
          <div class="settings-notes"><p id="direction-hint" class="hint">위키링크를 상대 링크로, PDF 페이지 참조를 이미지로 변환합니다.</p><div class="repair-help"><label class="repair-option"><input id="fix" type="checkbox">Confluence 변환 오류 보정</label><button id="repair-help-button" class="info-mark" type="button" aria-label="Confluence 변환 오류 보정 설명" aria-describedby="repair-tooltip">i</button><div id="repair-tooltip" class="help-tooltip" role="tooltip" hidden>옛 Confluence 문서의 CSS 잔해, 중복 제목, 코드블록 언어와 불필요한 이스케이프를 보정합니다. 미리보기에서 변경 내용을 확인하세요.</div></div></div>
        </div>
        <div class="action-bar"><span class="save-note">선택한 대상과 참조 첨부파일을 저장합니다.</span><div class="actions"><button id="next-document" class="quiet" disabled>다른 문서 선택</button><button id="preview" disabled>변환 미리보기</button><button id="save" class="primary" disabled>변환 후 저장 <span aria-hidden="true">↗</span></button></div></div>
        <div class="feedback"><div id="status" class="status" role="status" aria-live="polite"></div><div id="result" class="result" hidden><div><strong>변환 결과 저장 완료</strong><p id="output"></p></div><button id="open">결과 폴더 열기 ↗</button></div><details id="details" hidden><summary>변환 내역</summary><pre id="log"></pre></details></div>
      </section>
      <section class="panel comparison" aria-label="본문 비교">
        <div class="panel-heading comparison-heading"><h2>본문 비교</h2><div class="diff-toolbar"><span id="preview-label" class="count">미리보기 대기</span><span class="toolbar-divider"></span><label class="layout-toggle"><input id="side-by-side" type="checkbox" checked>나란히</label><div class="diff-navigation"><button id="previous-change" class="quiet" aria-label="이전 변경" title="이전 변경" disabled>↑</button><button id="next-change" class="quiet" aria-label="다음 변경" title="다음 변경" disabled>↓</button></div></div></div>
        <div id="preview-documents" class="preview-documents" hidden><label for="preview-document">비교할 문서</label><select id="preview-document"></select><span id="preview-count" class="hint"></span></div><div class="diff-labels"><span><i class="legend-before"></i>원본</span><span><i class="legend-after"></i>변환 결과</span><span class="read-only">읽기 전용</span></div>
        <div id="editor-error" role="alert" hidden></div><div class="editor-shell"><div id="diff" class="diff" aria-label="Monaco 본문 비교"></div><div id="comparison-empty" class="comparison-empty"><span class="empty-symbol" aria-hidden="true">⇄</span><strong>변경된 부분을 한눈에</strong><p>문서를 선택하고 미리보기를 누르면<br>원본과 변환 결과를 비교할 수 있습니다.</p><div class="empty-legend"><span><i class="legend-before"></i>삭제</span><span><i class="legend-after"></i>추가</span></div></div></div>
      </section>
    </div>
    ${syncPanel}
  </div>
  <footer><span id="workspace-note"><i></i>변환은 이 컴퓨터에서 처리됩니다.</span><span>Markdown · Confluence</span></footer>
<dialog id="local-connect-dialog" class="local-connect-dialog" aria-labelledby="local-connect-title">
  <h2 id="local-connect-title">내 컴퓨터의 csync 연결</h2>
  <p>이 웹은 화면만 제공합니다. 로컬 csync가 문서·첨부·연결 정보를 처리합니다.</p>
  <ol><li>내 컴퓨터에서 아래 명령을 실행하세요.</li><li>터미널에 표시된 연결 링크를 이 브라우저에서 여세요.</li><li>로컬 네트워크 접근 요청이 나오면 허용하고 연결을 누르세요.</li></ol>
  <pre id="local-connect-command">csync web --ui https://배포주소 --base /문서폴더</pre>
  <form id="local-connect-form">
    <label for="local-connect-endpoint">로컬 실행기 주소</label><input id="local-connect-endpoint" type="url" value="http://127.0.0.1:4318" required autocomplete="off">
    <label for="local-connect-token">연결 키</label><input id="local-connect-token" type="password" required autocomplete="off" spellcheck="false">
    <p>연결한 웹에 로컬 csync의 파일 작업 권한을 부여합니다. 신뢰하는 웹만 연결하세요. 연결 키는 이 탭의 세션에만 보관하며 csync를 종료하면 만료됩니다.</p>
    <p id="local-connect-note" role="status" aria-live="polite"></p><button id="local-connect-submit" class="primary" type="submit">내 컴퓨터에 연결</button>
  </form>
</dialog>
<dialog id="browser-folder-dialog" class="local-connect-dialog" aria-labelledby="browser-folder-title">
  <h2 id="browser-folder-title">내 컴퓨터의 문서 폴더 열기</h2>
  <p>로컬 프로그램 설치 없이 브라우저에서 문서 폴더를 선택하세요. 읽기·쓰기 권한을 허용하면 결과를 같은 폴더에 반영할 수 있습니다.</p>
  <p>${runtime==='standalone'?'변환과 변경 확인은 브라우저에서 처리합니다. Confluence 통신에 필요한 인증과 업로드 대상 문서·첨부만 중계 API로 전달합니다. 큰 첨부는 전송 동안 비공개 임시 저장소를 거칩니다. 작업 중에는 이 탭을 열어 두세요.':'선택한 문서·출력·참조 폴더의 파일과 .env를 Docker 서버의 세션별 임시 작업공간으로 전달해 처리합니다. 출력은 전용 결과 폴더를 선택하세요. 작업공간은 연결 해제 또는 유휴 만료 시 정리합니다.'}</p>
  <p>데스크톱 Chrome·Edge와 HTTPS가 필요합니다. 파일별 100MiB, 전체 512MiB까지 처리합니다.</p>
  <p id="browser-folder-status" role="status" aria-live="polite"></p>
  <button id="browser-folder-resume" class="primary" type="button" hidden>이전 폴더 다시 연결</button>
  <button id="browser-folder-open" class="primary" type="button">문서 폴더 열기</button>
</dialog>
<dialog id="browser-apply-dialog" class="local-connect-dialog" aria-labelledby="browser-apply-title">
  <h2 id="browser-apply-title">로컬 파일 적용 확인</h2><p id="browser-apply-status" role="alert"></p>
  <p>처리 결과는 아직 보관 중입니다. 로컬 수정 사항을 다른 곳에 보관하거나 충돌을 해결한 뒤 다시 시도하세요. 이 창을 닫거나 새 작업으로 덮어쓰지 않습니다.</p>
  <button id="browser-apply-retry" class="primary" type="button">다시 적용 확인</button>
</dialog>
<dialog id="overwrite-dialog" class="env-confirm-dialog overwrite-dialog" aria-labelledby="overwrite-title" aria-describedby="overwrite-warning">
  <h3 id="overwrite-title">파일 덮어쓰기 확인</h3>
  <p class="hint">저장 위치</p><p id="overwrite-path" class="overwrite-path"></p>
  <p id="overwrite-warning" class="restore-warning"></p>
  <ul id="overwrite-files" class="overwrite-files" aria-label="덮어쓸 파일"></ul>
  <div class="actions"><button id="overwrite-cancel" type="button" autofocus>취소</button><button id="overwrite-confirm" type="button" class="primary">덮어쓰기</button></div>
</dialog>
${helpDialog}
<dialog id="table-review-dialog" class="table-review-dialog" aria-labelledby="table-review-title"><div class="panel-heading"><h2 id="table-review-title">문서 서식 변경 확인</h2><button id="table-review-close">닫기</button></div><p id="format-review-note" class="table-review-note">기본 서식과 표 조절을 함께 확인한 뒤 저장하세요.</p><div id="table-review-diff" class="table-review-diff"></div><p id="table-save-status" role="status" aria-live="polite"></p><div class="table-review-footer"><button id="table-save" class="primary">원본 파일에 저장</button></div></dialog>
</main><aside id="activity-panel" class="activity-panel" role="status" aria-live="polite" aria-atomic="false" hidden><span class="activity-spinner" aria-hidden="true"></span><div class="activity-content"><strong id="activity-title"></strong><p id="activity-detail"></p><div class="activity-meta"><time id="activity-elapsed" aria-hidden="true"></time><a id="activity-link" href="#sync-results" hidden>실행 내역 보기 ↓</a></div></div></aside><aside id="snackbars" class="snackbars" aria-label="작업 알림"></aside><script src="/assets/app.js" type="module"></script></body></html>`;
