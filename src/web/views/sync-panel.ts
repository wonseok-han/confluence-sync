export const syncPanel = `
<div id="sync-view" class="workspace-content" role="tabpanel" aria-labelledby="tab-sync" hidden>
  <section class="panel" aria-label="동기화 설정">
    <div class="panel-heading"><h2><span class="section-number">02</span>Confluence 동기화</h2><span class="count">Markdown → Confluence</span></div>
    <div class="settings-body sync-settings">
      <p class="sync-intro">로컬 문서를 Confluence에 올립니다. 신규·변경 문서를 먼저 확인하세요.</p>
      <div class="settings-grid">
        <div class="field"><label for="sync-scope">동기화 범위</label><select id="sync-scope"><option value="file">선택 문서</option><option value="folder">현재 폴더</option><option value="all">기준 폴더 전체</option></select></div>
        <div class="field"><label for="sync-env">설정 파일 <span>선택 사항</span></label><div class="path-row"><input id="sync-env" class="path-input" placeholder="기준 폴더의 .env 자동 사용"><button id="sync-load">설정 확인</button></div></div>
      </div>
      <div class="field"><label for="sync-references">참조 문서 폴더 <span>선택 사항 · 한 줄에 한 경로</span></label><textarea id="sync-references" class="path-input" rows="3" placeholder="다른 동기화 폴더 경로"></textarea><button id="sync-add-reference" type="button">참조 폴더 추가…</button><p class="hint">참조 폴더의 게시 매핑으로 링크를 연결합니다. 같은 Confluence 서버의 폴더를 지정하세요. 참조 문서는 업로드하지 않습니다.</p></div>
      <p id="sync-target" class="sync-target">왼쪽에서 문서를 선택하세요.</p>
      <p class="hint">설정 경로를 비우면 기준 폴더의 .env를 사용합니다. 없으면 웹 서버 실행 환경을 사용합니다.</p>
      <dl id="sync-config" class="sync-config"><dt>연결 설정</dt><dd>설정 확인을 누르면 업로드 위치를 볼 수 있습니다.</dd></dl>
      <p id="sync-config-status" class="hint" role="status"></p>
      <label class="repair-option"><input id="sync-verify" type="checkbox">변경 없는 문서도 Confluence 페이지 존재 확인</label>
      <p class="hint">.confluence-syncignore와 기존 페이지 매핑을 적용합니다. 미리보기는 로컬 변경 비교이며 서버 연결·권한은 검사하지 않습니다.</p>
    </div>
    <div class="action-bar"><span class="save-note">먼저 대상을 확인한 뒤 업로드하세요.</span><div class="actions"><button id="sync-preview" disabled>동기화 미리보기</button><button id="sync-push" class="primary" disabled>Confluence에 동기화</button></div></div>
    <div class="feedback"><p id="sync-status" class="status" role="status" aria-live="polite">문서를 선택하고 동기화 미리보기를 실행하세요.</p><button id="sync-reconnect" hidden>진행 상태 다시 확인</button></div>
  </section>
  <section class="panel sync-results" aria-label="동기화 내역">
    <div class="panel-heading"><h2><span class="section-number">03</span>대상 및 실행 내역</h2><span id="sync-job-state" class="count">대기</span></div>
    <div class="sync-result-body"><p id="sync-job-summary" class="hint" hidden></p><p id="sync-log-empty" class="empty">미리보기하면 문서별 신규·변경·동일 상태와 부모 계층을 확인할 수 있습니다.</p><pre id="sync-log" tabindex="0" aria-label="동기화 로그" hidden></pre></div>
  </section>
</div>`;
