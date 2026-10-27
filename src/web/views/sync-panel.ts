export const syncPanel = `
<div id="sync-view" class="workspace-content" role="tabpanel" aria-labelledby="tab-sync" hidden>
  <section class="panel env-settings" aria-labelledby="sync-env-heading">
        <div class="panel-heading"><h2 id="sync-env-heading">.env 연결 설정 <span class="subtle-label">먼저 설정</span></h2><button id="sync-load" type="button">설정 확인</button></div>
    <div class="env-settings-body">
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
  <section class="panel" aria-label="Confluence 작업 설정">
    <div class="panel-heading"><h2><span class="section-number">02</span>Confluence</h2><span class="count" id="sync-direction-label">로컬 → Confluence</span></div>
    <div class="settings-body sync-settings">
      <div class="sync-direction" role="group" aria-label="Confluence 작업 방향"><button id="sync-direction-push" type="button" aria-pressed="true">↑ 업로드 (Push)</button><button id="sync-direction-pull" type="button" aria-pressed="false">↓ 가져오기 (Pull)</button></div>
      <p id="sync-direction-note" class="sync-intro">01의 기준 폴더는 스페이스 루트에 대응합니다. 실제 Push·Pull 대상은 저장된 작업 스코프입니다.</p>
      <div id="sync-push-options" class="sync-push-options">
        <section class="sync-option-section" aria-labelledby="sync-range-heading">
          <h3 id="sync-range-heading">업로드할 범위</h3>
          <p class="hint">01에 저장한 스코프와 제외 규칙을 적용합니다. 범위를 바꾸려면 01에서 다시 저장하세요.</p>
          <p id="sync-target" class="sync-target">01에서 기준 폴더를 선택하세요.</p>
        </section>
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
      <p id="sync-pull-note" class="sync-target" hidden>저장된 로컬 작업 스코프의 문서를 원래 경로로 가져옵니다. 로컬 변경·이동 대기가 있으면 중단합니다. 자동 병합하지 않습니다.</p>
    </div>
    <div class="action-bar"><span class="save-note">작업 방향과 로컬 작업 스코프를 확인하세요.</span><div class="actions"><button id="sync-fetch" type="button" title="원격 메타데이터만 확인합니다. 본문·첨부는 받지 않으며 2분 이내에는 캐시를 재사용합니다." disabled>원격 변경 확인 (Fetch)</button><button id="sync-preview" disabled>업로드 미리보기</button><button id="sync-push" class="primary" disabled>Confluence에 업로드</button><button id="sync-pull" class="primary" disabled hidden>Confluence에서 가져오기</button></div></div>
    <div class="feedback"><p id="sync-status" class="status" role="status" aria-live="polite">작업 방향을 선택하고 연결 설정과 스코프를 확인하세요.</p><button id="sync-reconnect" hidden>진행 상태 다시 확인</button></div>
  </section>

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
