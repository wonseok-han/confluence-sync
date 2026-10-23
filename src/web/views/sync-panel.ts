export const syncPanel = `
<div id="sync-view" class="workspace-content" role="tabpanel" aria-labelledby="tab-sync" hidden>
  <section class="panel" aria-label="Confluence 작업 설정">
    <div class="panel-heading"><h2><span class="section-number">02</span>Confluence</h2><span class="count" id="sync-direction-label">로컬 → Confluence</span></div>
    <div class="settings-body sync-settings">
      <div class="sync-direction" role="group" aria-label="Confluence 작업 방향"><button id="sync-direction-push" type="button" aria-pressed="true">↑ 업로드 (Push)</button><button id="sync-direction-pull" type="button" aria-pressed="false">↓ 가져오기 (Pull)</button></div>
      <p id="sync-direction-note" class="sync-intro">01의 기준 폴더 전체 → 저장된 원격 스코프. 문서 선택은 미리보기·편집에만 사용합니다.</p>
      <section class="env-settings" aria-labelledby="sync-env-heading">
        <div class="env-settings-heading"><h3 id="sync-env-heading">.env 연결 설정</h3><button id="sync-load" type="button">설정 확인</button></div>
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
      </section>
      <section class="scope-picker" aria-labelledby="sync-scope-heading">
        <div class="scope-picker-heading">
          <div><h3 id="sync-scope-heading">원격 스코프</h3><p>이 로컬 폴더와 연결할 Confluence 위치를 선택하세요.</p></div>
          <span class="scope-required">필수 설정</span>
        </div>
        <div class="scope-picker-body">
          <aside id="sync-scope-warning" class="scope-warning" aria-label="루트 스코프 설정 주의">
            <strong>주의: 루트(<code>/</code>)는 작업 범위가 넓습니다.</strong>
            <p>스페이스 홈과 하위 트리 전체가 작업 범위가 됩니다. 로컬 기준 폴더를 잘못 연결하면 Push 시 의도하지 않은 페이지가 생성되거나 기존 페이지의 내용·위치가 변경될 수 있습니다.</p>
            <p>가능하면 관리할 하위 스코프를 선택하세요. 루트가 필요하다면 01의 기준 폴더와 업로드 미리보기를 반드시 확인하세요.</p>
          </aside>
          <div class="scope-navigation">
            <div class="scope-step-label">Confluence 트리</div>
            <button id="sync-scope-browse" type="button">트리 불러오기</button>
          </div>
          <p class="hint">화살표로 하위 항목을 펼치고, 이름을 눌러 관리할 위치를 선택하세요.</p>
          <nav id="sync-scope-tree" class="scope-tree" aria-label="원격 스코프 탐색" aria-describedby="sync-scope-warning sync-scope-help"><p class="scope-tree-empty">트리를 불러오면 페이지와 폴더를 탐색할 수 있습니다.</p></nav>
          <div class="scope-summary">
            <div><span>저장된 스코프</span><p id="sync-scope-saved">설정 확인으로 불러오세요.</p></div>
            <div><span>선택 중인 위치</span><p id="sync-scope-candidate" aria-live="polite">아직 선택하지 않았습니다.</p></div>
          </div>
          <div class="scope-picker-actions"><span class="hint">저장해야 스코프에 반영됩니다.</span><button id="sync-scope-save" type="button" class="primary" disabled>이 위치를 스코프로 저장</button></div>
        </div>
        <div class="scope-picker-note" id="sync-scope-help"><p>선택한 원격 위치가 로컬 기준 폴더 자체에 대응합니다. 전체를 관리하려면 <code>/</code>를 직접 선택하세요.</p><p>트리 조회와 스코프 저장은 문서 본문을 다운로드하거나 업로드하지 않습니다.</p></div>
      </section>
      <div id="sync-push-options" class="sync-push-options">
      <div class="field"><label for="sync-references">참조 문서 폴더 <span>선택 사항 · 한 줄에 한 경로</span></label><textarea id="sync-references" class="path-input" rows="3" placeholder="다른 동기화 폴더 경로"></textarea><button id="sync-add-reference" type="button">참조 폴더 추가…</button><p class="hint">참조 폴더의 게시 매핑으로 링크를 연결합니다. 같은 Confluence 서버의 폴더를 지정하세요. 참조 문서는 업로드하지 않습니다.</p></div>
      <p id="sync-target" class="sync-target">01에서 기준 폴더를 선택하세요.</p>
      <label class="repair-option"><input id="sync-verify" type="checkbox">미리보기에서 원격 버전·페이지 존재 확인</label>
      <p class="hint">저장된 관리 범위와 제외 규칙을 적용합니다. 원격 확인을 선택하면 미리보기에서도 Confluence를 조회하며, 파일이나 원격 내용을 변경하지 않습니다.</p>
      </div>
      <p id="sync-pull-note" class="sync-target" hidden>저장된 원격 스코프 전체를 01의 기준 폴더로 가져옵니다. 로컬 변경·이동 대기가 있으면 중단합니다. 자동 병합하지 않습니다.</p>
    </div>
    <div class="action-bar"><span class="save-note">작업 방향과 원격 스코프를 확인하세요.</span><div class="actions"><button id="sync-preview" disabled>업로드 미리보기</button><button id="sync-push" class="primary" disabled>Confluence에 업로드</button><button id="sync-pull" class="primary" disabled hidden>Confluence에서 가져오기</button></div></div>
    <div class="feedback"><p id="sync-status" class="status" role="status" aria-live="polite">작업 방향을 선택하고 연결 설정과 스코프를 확인하세요.</p><button id="sync-reconnect" hidden>진행 상태 다시 확인</button></div>
  </section>
  <dialog id="scope-review-dialog" class="env-confirm-dialog scope-review-dialog" aria-labelledby="scope-review-title">
    <h3 id="scope-review-title">스코프 연결 변경 확인</h3>
    <p id="scope-review-transition"></p><p id="scope-review-counts"></p>
    <ul id="scope-review-items" class="scope-review-items"></ul>
    <p class="scope-warning">저장은 연결 설정만 바꿉니다. 문서·매핑·원격 내용은 유지됩니다. 범위 밖 문서나 루트·폴더 충돌이 남아 있으면 Push는 차단됩니다. 페이지 위치 변경은 이후 Push에서 원격 버전과 범위를 검증한 뒤 반영합니다.</p>
    <div class="actions"><button id="scope-review-cancel" type="button">취소</button><button id="scope-review-confirm" type="button" class="primary">영향 확인 후 스코프 저장</button></div>
  </dialog>
  <dialog id="sync-env-confirm" class="env-confirm-dialog" aria-labelledby="sync-env-confirm-title">
    <h3 id="sync-env-confirm-title">기존 .env의 연결 설정을 바꿀까요?</h3>
    <p id="sync-env-confirm-path" class="hint"></p>
    <p>서버 주소, 계정, API 토큰, 스페이스 키를 가져온 값으로 교체합니다. 다른 환경변수는 유지합니다.</p>
    <div class="actions"><button id="sync-env-confirm-cancel" type="button">취소</button><button id="sync-env-confirm-save" type="button" class="primary">연결 설정 교체 후 저장</button></div>
  </dialog>
  <section class="panel sync-results" aria-label="Confluence 작업 내역">
    <div class="panel-heading"><h2><span class="section-number">03</span>대상 및 실행 내역</h2><span id="sync-job-state" class="count">대기</span></div>
    <div class="sync-result-body"><p id="sync-job-summary" class="hint" hidden></p><p id="sync-log-empty" class="empty">미리보기하면 문서별 신규·변경·동일 상태와 부모 계층을 확인할 수 있습니다.</p><pre id="sync-log" tabindex="0" aria-label="Confluence 작업 로그" hidden></pre></div>
  </section>
</div>`;
