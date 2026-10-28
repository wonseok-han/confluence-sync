export const syncPanel = `
<div id="sync-view" class="workspace-content" role="tabpanel" aria-labelledby="tab-sync" hidden>
  <section class="panel env-settings" aria-labelledby="sync-env-heading">
        <div class="panel-heading"><h2 id="sync-env-heading"><button id="sync-env-toggle" class="preview-disclosure" type="button" aria-expanded="false" aria-controls="sync-env-body"><span id="sync-env-chevron" aria-hidden="true">▸</span>.env 연결 설정<span id="sync-env-toggle-label" class="preview-disclosure-label">펼치기</span></button></h2><div class="actions"><button id="sync-load" type="button">설정 확인</button><button id="sync-connect" type="button" disabled>스페이스 연결</button></div></div>
    <div id="sync-env-body" class="env-settings-body" hidden>
        <p class="hint">API 토큰이 없나요? <button id="open-token-guide" class="quiet" type="button" aria-haspopup="dialog" aria-controls="help-dialog">API 토큰 발급 가이드</button></p>
        <fieldset class="env-source-options"><legend class="sr-only">환경변수 설정 방식</legend>
          <label><input type="radio" name="sync-env-source" id="sync-env-base-mode" checked><span><strong>기준 폴더의 .env 사용</strong><small>01에서 선택한 폴더의 설정을 읽습니다.</small></span></label>
          <label><input type="radio" name="sync-env-source" id="sync-env-import-mode"><span><strong>.env 가져오기</strong><small>파일을 선택해 현재 웹 작업에 적용합니다.</small></span></label>
        </fieldset>
        <div id="sync-env-import-controls" class="env-import-controls" hidden>
          <input type="file" id="sync-env-file" hidden>
          <div class="env-file-row"><button id="sync-env-choose" type="button">.env 파일 선택…</button><span id="sync-env-file-name">선택한 파일 없음</span></div>
          <button id="sync-env-save" type="button" disabled>기준 폴더에 .env 저장</button>
        </div>
        <p id="sync-env-source-note" class="hint">01에서 선택한 기준 폴더의 .env만 읽습니다. 파일이 없으면 .env를 가져오세요.</p>
        <div class="env-config-summary"><h4>적용된 연결 정보</h4>
      <dl id="sync-config" class="sync-config"><dt>연결 설정</dt><dd>설정 확인을 누르면 서버·계정·스페이스를 볼 수 있습니다.</dd></dl>
      <p id="sync-config-status" class="hint" role="status"></p>
        </div>
    </div>
  </section>
  <section class="panel sync-workbench" aria-label="Confluence 작업 설정">
    <div class="panel-heading"><h2><span class="section-number">02</span>Confluence</h2><span id="sync-stage-count" class="count">0개 업로드 예정</span></div>
    <div class="sync-workbench-body">
      <p id="sync-target" class="sync-target">01에서 스페이스 전체를 보관할 기준 폴더를 선택하세요.</p>
      <div class="sync-workbench-toolbar">
        <div class="actions" aria-label="원격 변경 확인 및 가져오기">
          <button id="sync-fetch" type="button" title="스페이스의 새 문서와 버전·위치 변경을 확인합니다. 2분 이내 결과는 재사용합니다." disabled>원격 변경 확인 (Fetch)</button>
          <button id="sync-pull-remote" type="button" disabled>↓ 원격 변경 가져오기 (Pull)</button>
          <button hidden id="sync-stage-scan" type="button">↻ 로컬 다시 확인</button>
        </div>
        <div class="actions" aria-label="업로드 대상 일괄 선택">
          <button id="sync-stage-add" type="button" disabled><span aria-hidden="true">＋</span> 변경 문서 모두 포함</button>
          <button id="sync-stage-remove" type="button" disabled><span aria-hidden="true">−</span> 모두 제외</button>
        </div>
      </div>
      <div class="sync-observation"><span id="sync-stage-checking" class="stage-checking" aria-hidden="true"><i class="activity-spinner" aria-hidden="true"></i>로컬 확인 중…</span><span>로컬 자동 확인 · 5초 간격 · API 호출 없음</span><span id="sync-stage-remote-note">원격 상태 미확인 · Fetch로 갱신하세요.</span></div>
      <div class="sync-change-heading"><h3 id="sync-stage-heading">변경사항</h3><span>받을 문서는 Pull · 보낼 변경은 체크 후 Push</span></div>
      <p id="sync-stage-note" class="hint" role="status">로컬 변경을 자동으로 확인합니다. 원격 상태는 Fetch를 눌러 확인하세요.</p>
      <div id="sync-stage-list" class="sync-stage-list" aria-label="업로드 문서 선택"></div>
    </div>
    <div class="sync-execution">
      <div class="sync-execution-heading"><h3>선택 문서 업로드</h3><span class="count">로컬 → Confluence</span></div>
      <p class="sync-intro">체크한 문서를 미리보기한 뒤 업로드하세요.</p>
      <details class="sync-advanced"><summary>추가 설정 <span>참조 문서 · 원격 검증</span></summary>
        <div class="sync-settings">
          <div id="sync-push-options" class="sync-push-options">
        <section class="sync-option-section" aria-labelledby="sync-reference-heading">
          <h3 id="sync-reference-heading">참조 문서 연결 <span class="subtle-label">선택 사항</span></h3>
          <p id="sync-references-help" class="hint">다른 동기화 폴더의 게시 매핑을 이용해 문서 링크를 연결합니다. 같은 Confluence 서버의 폴더를 지정하세요. 참조 문서는 업로드하지 않습니다.</p>
          <div class="field"><label for="sync-references">참조 문서 폴더 <span>한 줄에 한 경로</span></label><textarea id="sync-references" class="path-input" rows="3" placeholder="다른 동기화 폴더 경로" aria-describedby="sync-references-help"></textarea></div>
          <button id="sync-add-reference" type="button">참조 폴더 추가…</button>
        </section>
        <section class="sync-option-section" aria-labelledby="sync-verify-heading">
          <h3 id="sync-verify-heading">미리보기 확인 옵션</h3>
          <label class="repair-option sync-verify-option"><input id="sync-verify" type="checkbox" aria-describedby="sync-verify-help">Confluence의 원격 버전과 페이지 존재 여부도 확인</label>
          <p id="sync-verify-help" class="hint">선택하면 미리보기 중 Confluence를 조회하므로 시간이 더 걸릴 수 있습니다. 파일과 원격 내용은 변경하지 않습니다.</p>
        </section>
      </div>
        </div>
      </details>
    </div>
    <div class="action-bar"><span class="save-note">받을 변경과 체크한 업로드 문서를 확인하세요.</span><div class="actions"><button id="sync-preview" disabled>업로드 미리보기</button><button id="sync-push" class="primary" disabled>Confluence에 업로드</button></div></div>
    <div class="feedback"><p id="sync-status" class="status" role="status" aria-live="polite">변경사항을 확인하고 받을 문서와 보낼 문서를 선택하세요.</p><button id="sync-reconnect" hidden>진행 상태 다시 확인</button></div>
  </section>

  <dialog id="sync-diff-dialog" class="sync-diff-dialog" aria-labelledby="sync-diff-title">
    <div class="panel-heading"><h2 id="sync-diff-title">문서 변경 비교</h2><button id="sync-diff-close" type="button">닫기</button></div>
    <div class="settings-body"><p id="sync-diff-path" class="sync-diff-path"></p><p id="sync-diff-note" class="hint" role="status"></p>
      <div class="actions"><button id="sync-diff-remote" type="button" hidden>원격과 비교 · 본문 1회 조회</button></div>
      <div id="sync-diff-labels" class="sync-diff-labels" hidden><span id="sync-diff-before-label">기준 Markdown</span><span>현재 로컬 Markdown</span></div>
      <div id="sync-diff-editor" class="sync-diff-editor" hidden></div>
    </div>
  </dialog>
  <dialog id="sync-restore-dialog" class="env-confirm-dialog restore-dialog" aria-labelledby="sync-restore-title" aria-describedby="sync-restore-warning">
    <h3 id="sync-restore-title">문서를 원격 최신으로 복구할까요?</h3>
    <p id="sync-restore-path" class="sync-diff-path"></p>
    <p id="sync-restore-warning" class="restore-warning"></p>
    <p class="hint">원격 문서는 변경하지 않습니다. 복구 후 업로드 선택에서 제외합니다. 다운로드 도중 추가 수정이 생기면 중단합니다.</p>
    <div class="actions"><button id="sync-restore-cancel" type="button">취소</button><button id="sync-restore-confirm" type="button" class="restore-confirm">원격에서 복구</button></div>
  </dialog>
  <dialog id="sync-env-confirm" class="env-confirm-dialog" aria-labelledby="sync-env-confirm-title">
    <h3 id="sync-env-confirm-title">기존 .env의 연결 설정을 바꿀까요?</h3>
    <p id="sync-env-confirm-path" class="hint"></p>
    <p>서버 주소, 계정, API 토큰, 스페이스 키를 가져온 값으로 교체합니다. 다른 환경변수는 유지합니다.</p>
    <div class="actions"><button id="sync-env-confirm-cancel" type="button">취소</button><button id="sync-env-confirm-save" type="button" class="primary">연결 설정 교체 후 저장</button></div>
  </dialog>
  <section id="sync-results" class="panel sync-results" aria-label="Confluence 작업 내역">
    <div class="panel-heading"><h2><span class="section-number">03</span>대상 및 실행 내역</h2><span id="sync-job-state" class="count">대기</span></div>
    <div class="sync-result-body"><p id="sync-job-summary" class="hint" hidden></p><p id="sync-log-empty" class="empty">미리보기하면 문서별 신규·변경·동일 상태와 부모 계층을 확인할 수 있습니다.</p><pre id="sync-log" tabindex="0" aria-label="Confluence 작업 로그" hidden></pre></div>
  </section>
</div>`;
