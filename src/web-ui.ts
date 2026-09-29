import { syncPanel } from './web-sync-ui.js';
/** HTML shell; Monaco and application code are bundled as local assets. */
export const webPage = (token: string) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="csync-token" content="${token}"><title>문서 워크스페이스 · confluence-sync</title><link rel="stylesheet" href="/assets/app.css"></head><body>
<header class="app-header"><a class="brand" href="/" aria-label="confluence-sync 홈"><span class="brand-symbol" aria-hidden="true">⇄</span>confluence<span class="brand-light">sync</span></a><span class="local-status"><i></i>로컬 워크스페이스</span></header>
<main class="app-main">
  <div class="page-heading"><div><div class="eyebrow">DOCUMENT WORKSPACE</div><h1>문서 워크스페이스<span class="title-dot">.</span></h1></div><p>문서를 변환하고, Confluence와 동기화하세요.</p></div>
  <div class="mode-tabs" role="tablist" aria-label="문서 작업"><button id="tab-convert" role="tab" aria-selected="true" aria-controls="convert-view">문서 변환</button><button id="tab-sync" role="tab" aria-selected="false" aria-controls="sync-view" tabindex="-1">Confluence 동기화</button></div>
  <div class="workspace">
    <aside class="panel explorer" aria-label="파일 탐색">
      <div class="panel-heading"><h2><span class="section-number">01</span>문서</h2><span id="count" class="count">폴더 탐색</span></div>
      <div class="folder-picker"><button id="choose-base" class="folder-button"><span aria-hidden="true">＋</span>문서 폴더 선택…</button><div class="path-row"><input id="base-input" class="path-input" aria-label="문서 폴더 경로" placeholder="폴더 경로 직접 입력"><button id="apply-base" class="quiet">열기</button></div><p class="hint">화살표로 펼치고, 이름을 눌러 선택하세요.</p></div>
      <div class="explorer-navigation"><button id="up" class="quiet" aria-label="상위 폴더" title="상위 폴더">↑</button><p id="path" class="path"></p></div>
      <div class="search-wrap"><span aria-hidden="true">⌕</span><input id="search" type="search" placeholder="하위 폴더까지 파일 이름 검색" aria-label="파일 이름 검색"></div>
      <div id="files" class="files"></div><div class="explorer-footer"><span class="file-type">MD</span>폴더 또는 Markdown을 선택하세요</div>
    </aside>
    <div id="convert-view" class="workspace-content" role="tabpanel" aria-labelledby="tab-convert">
      <section class="panel settings" aria-label="변환 설정">
        <div class="panel-heading"><h2><span class="section-number">02</span>변환 설정</h2><span class="subtle-label">원본 유지</span></div>
        <div class="settings-body">
          <div class="document-summary"><span class="document-symbol" aria-hidden="true">MD</span><div><div id="selected" class="selected-name">변환할 문서를 선택하세요</div><div id="base" class="base">왼쪽에서 폴더를 열어 시작하세요.</div></div></div>
          <p id="convert-output-hint" class="hint"></p><div class="settings-grid"><div class="field"><label for="direction">변환 형식</label><select id="direction"><option value="markdown">Markdown</option><option value="obsidian">Obsidian</option><option value="repair">Confluence 오류 보정만</option></select></div><div class="field output-field"><label for="out-input">출력 폴더 <span>선택 사항</span></label><div class="path-row"><input id="out-input" class="path-input" placeholder="자동으로 새 폴더 생성"><button id="choose-out">폴더 선택…</button></div></div></div>
          <div class="settings-notes"><p id="direction-hint" class="hint">위키링크를 상대 링크로, PDF 페이지 참조를 이미지로 변환합니다.</p><div class="repair-help"><label class="repair-option"><input id="fix" type="checkbox">Confluence 변환 오류 보정</label><button id="repair-help-button" class="info-mark" type="button" aria-label="Confluence 변환 오류 보정 설명" aria-describedby="repair-tooltip">i</button><div id="repair-tooltip" class="help-tooltip" role="tooltip" hidden>옛 Confluence 문서의 CSS 잔해, 중복 제목, 코드블록 언어와 불필요한 이스케이프를 보정합니다. 미리보기에서 변경 내용을 확인하세요.</div></div></div>
        </div>
        <div class="action-bar"><span class="save-note">선택한 대상과 참조 첨부파일을 저장합니다.</span><div class="actions"><button id="next-document" class="quiet" disabled>다른 문서 선택</button><button id="preview" disabled>미리보기</button><button id="save" class="primary" disabled>변환 후 저장 <span aria-hidden="true">↗</span></button></div></div>
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
</main><script src="/assets/app.js" type="module"></script></body></html>`;
