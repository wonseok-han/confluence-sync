import { readPkgVersion } from '../../shared/version.js';
import { helpDialog } from './help.js';
import { syncPanel } from './sync-panel.js';
/** HTML shell; Monaco and application code are bundled as local assets. */
export const webPage = (token: string) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="csync-token" content="${token}"><title>문서 워크스페이스 · confluence-sync</title><link rel="icon" type="image/svg+xml" href="/assets/favicon.svg"><link rel="stylesheet" href="/assets/app.css"></head><body>
<header class="app-header"><a class="brand" href="/" aria-label="confluence-sync 홈"><span class="brand-symbol" aria-hidden="true">⇄</span>confluence<span class="brand-light">sync</span></a><span class="app-version" aria-label="현재 버전">v${readPkgVersion()}</span><span class="local-status"><i></i>로컬 워크스페이스</span></header>
<main class="app-main">
  <div class="page-heading"><div><div class="eyebrow">DOCUMENT WORKSPACE</div><h1>문서 워크스페이스<span class="title-dot">.</span></h1></div><div class="page-heading-actions"><p>문서를 변환하고, Confluence에서 가져오거나 업로드하세요.</p><button id="open-help" aria-haspopup="dialog" aria-controls="help-dialog">사용 도움말</button></div></div>
  <div class="mode-tabs" role="tablist" aria-label="문서 작업"><button id="tab-convert" role="tab" aria-selected="true" aria-controls="convert-view">문서 변환</button><button id="tab-sync" role="tab" aria-selected="false" aria-controls="sync-view" tabindex="-1">Confluence</button></div>
  <div class="workspace">
    <aside class="panel explorer" aria-label="파일 탐색">
      <div class="panel-heading"><h2><span class="section-number">01</span>로컬 문서</h2><span id="count" class="count">폴더 탐색</span></div>
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
        <div class="panel-heading document-preview-heading"><h2><button id="document-preview-toggle" class="preview-disclosure" aria-expanded="false" aria-controls="document-preview-body"><span id="document-preview-chevron" aria-hidden="true">▸</span>문서 미리보기<span id="document-preview-toggle-label" class="preview-disclosure-label">펼치기</span></button></h2><div id="document-preview-actions" class="actions" hidden><button id="table-edit-toggle" class="quiet" aria-pressed="false" disabled>표 서식 편집</button><button id="document-preview-refresh" class="quiet" disabled>새로고침</button></div></div>
        <div id="document-preview-body" hidden>
        <p id="document-preview-status" class="document-preview-status" role="status" aria-live="polite">Markdown 파일을 선택하면 본문이 표시됩니다.</p>
        <div id="table-format-controls" class="table-format-controls" hidden>
          <p id="table-format-status" role="status" aria-live="polite">미리보기에서 편집할 표를 클릭하세요.</p>
          <div class="table-format-actions"><label>전체 너비 <input id="table-total-width" type="range" min="320" max="1200" step="1" disabled><output id="table-total-label"></output></label><button id="table-fit" title="셀의 글자 길이에 맞춰 열 너비 자동 배분" disabled>내용에 맞춤</button><button id="table-equal" disabled>균등 배분</button><button id="table-review" class="primary" disabled>변경 비교</button><button id="table-revert" disabled>변경 취소</button></div>
          <p class="hint">내용에 맞춤으로 자동 배분하거나 열 경계를 드래그하세요. 저장 전 변경은 파일을 바꾸면 취소됩니다.</p>
        </div>
        <iframe id="document-preview-frame" class="document-preview-frame" title="선택한 Markdown 문서 미리보기" sandbox="allow-scripts" hidden></iframe>
        <p class="document-preview-note">로컬 문서 미리보기이며 Confluence의 실제 표시와 다를 수 있습니다.</p>
        </div>
      </section>
      <section class="panel settings" aria-label="변환 설정">
        <div class="panel-heading"><h2><span class="section-number">02</span>변환 설정</h2><span class="subtle-label">원본 유지</span></div>
        <div class="settings-body">
          <div class="document-summary"><span class="document-symbol" aria-hidden="true">MD</span><div><div id="selected" class="selected-name">변환할 문서를 선택하세요</div><div id="base" class="base">왼쪽에서 폴더를 열어 시작하세요.</div></div></div>
          <p id="convert-output-hint" class="hint"></p><div class="settings-grid"><div class="field"><label for="direction">변환 형식</label><select id="direction"><option value="markdown">Markdown</option><option value="obsidian">Obsidian</option><option value="repair">Confluence 오류 보정만</option></select></div><div class="field output-field"><label for="out-input">출력 폴더 <span>선택 사항</span></label><div class="path-row"><input id="out-input" class="path-input" placeholder="자동으로 새 폴더 생성"><button id="choose-out">폴더 선택…</button></div></div></div>
          <div class="settings-notes"><p id="direction-hint" class="hint">위키링크를 상대 링크로, PDF 페이지 참조를 이미지로 변환합니다.</p><div class="repair-help"><label class="repair-option"><input id="fix" type="checkbox">Confluence 변환 오류 보정</label><button id="repair-help-button" class="info-mark" type="button" aria-label="Confluence 변환 오류 보정 설명" aria-describedby="repair-tooltip">i</button><div id="repair-tooltip" class="help-tooltip" role="tooltip" hidden>옛 Confluence 문서의 CSS 잔해, 중복 제목, 코드블록 언어와 불필요한 이스케이프를 보정합니다. 미리보기에서 변경 내용을 확인하세요.</div></div></div>
        </div>
        <div class="action-bar"><span class="save-note">선택한 대상과 참조 첨부파일을 저장합니다.</span><div class="actions"><button id="next-document" class="quiet" disabled>다른 문서 선택</button><button id="preview" disabled>변환 미리보기</button><button id="save" class="primary" disabled>변환 후 저장 <span aria-hidden="true">↗</span></button></div></div>
        <div class="feedback"><div id="status" class="status" role="status" aria-live="polite"></div><div id="result" class="result" hidden><div><strong>변환 결과 저장 완료</strong><p id="output"></p></div><button id="open">결과 폴더 열기 ↗</button></div><details id="details" hidden><summary>변환 내역</summary><pre id="log"></pre></details></div>
      </section>
      <section class="panel comparison" aria-label="본문 비교">
        <div class="panel-heading comparison-heading"><h2><span class="section-number">03</span>본문 비교</h2><div class="diff-toolbar"><span id="preview-label" class="count">미리보기 대기</span><span class="toolbar-divider"></span><label class="layout-toggle"><input id="side-by-side" type="checkbox" checked>나란히</label><div class="diff-navigation"><button id="previous-change" class="quiet" aria-label="이전 변경" title="이전 변경" disabled>↑</button><button id="next-change" class="quiet" aria-label="다음 변경" title="다음 변경" disabled>↓</button></div></div></div>
        <div id="preview-documents" class="preview-documents" hidden><label for="preview-document">비교할 문서</label><select id="preview-document"></select><span id="preview-count" class="hint"></span></div><div class="diff-labels"><span><i class="legend-before"></i>원본</span><span><i class="legend-after"></i>변환 결과</span><span class="read-only">읽기 전용</span></div>
        <div id="editor-error" role="alert" hidden></div><div class="editor-shell"><div id="diff" class="diff" aria-label="Monaco 본문 비교"></div><div id="comparison-empty" class="comparison-empty"><span class="empty-symbol" aria-hidden="true">⇄</span><strong>변경된 부분을 한눈에</strong><p>문서를 선택하고 미리보기를 누르면<br>원본과 변환 결과를 비교할 수 있습니다.</p><div class="empty-legend"><span><i class="legend-before"></i>삭제</span><span><i class="legend-after"></i>추가</span></div></div></div>
      </section>
    </div>
    ${syncPanel}
  </div>
  <footer><span id="workspace-note"><i></i>변환은 이 컴퓨터에서 처리됩니다.</span><span>Markdown · Confluence</span></footer>
${helpDialog}
<dialog id="table-review-dialog" class="table-review-dialog" aria-labelledby="table-review-title"><div class="panel-heading"><h2 id="table-review-title">표 서식 변경 확인</h2><button id="table-review-close">닫기</button></div><p class="table-review-note">편집한 표들의 너비 변경을 함께 저장합니다. 일반 Markdown 표는 HTML 표로 변환합니다.</p><div id="table-review-diff" class="table-review-diff"></div><p id="table-save-status" role="status" aria-live="polite"></p><div class="table-review-footer"><button id="table-save" class="primary">원본 파일에 저장</button></div></dialog>
</main><aside id="activity-panel" class="activity-panel" role="status" aria-live="polite" aria-atomic="false" hidden><span class="activity-spinner" aria-hidden="true"></span><div class="activity-content"><strong id="activity-title"></strong><p id="activity-detail"></p><div class="activity-meta"><time id="activity-elapsed" aria-hidden="true"></time><a id="activity-link" href="#sync-results" hidden>실행 내역 보기 ↓</a></div></div></aside><aside id="snackbars" class="snackbars" aria-label="작업 알림"></aside><script src="/assets/app.js" type="module"></script></body></html>`;
