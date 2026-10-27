/** Only annotated, account-redacted screenshots are included in the web build. */
const steps = [
  ['01-account-settings', '계정 설정 열기', 'Confluence 오른쪽 위 프로필 아이콘을 누른 다음 Account settings를 선택합니다.'],
  ['02-atlassian-security', '보안 → API 토큰 관리', '상단 보안 탭에서 API 토큰 만들기 및 관리를 누릅니다. 아래 바로가기 링크로도 이동할 수 있습니다.'],
  ['03-api-tokens', '범위를 포함한 토큰 만들기', '범위를 포함하여 API 토큰 만들기를 선택합니다.'],
  ['04-scope-api-token-step1', '이름과 만료일 입력', 'Name에 용도를 알 수 있는 이름(예: csync)을 입력하고 만료일을 정한 뒤 다음으로 진행합니다. 스크린샷의 날짜는 예시입니다.'],
  ['05-scope-api-token-step2', 'Confluence 앱 선택', '앱 목록에서 Confluence를 선택하고 다음을 누릅니다.'],
  ['06-scope-api-token-step3', '필요한 권한 검색·선택', '권한 이름을 검색하고 결과 왼쪽 체크박스를 선택합니다. 필요한 권한마다 반복한 뒤 다음으로 진행합니다. 아래 표를 기준으로 선택하세요.'],
  ['07-scope-api-token-step4', '검토 후 토큰 만들기', '이름·만료일·앱·선택한 권한을 확인하고 토큰 만들기를 누릅니다. 화면의 read:space 하나는 예시이며 csync 전체 기능에 충분하지 않습니다.'],
];
export const tokenGuide = `<section id="help-token"><h3>API 토큰 발급 가이드</h3>
<p>빨간 테두리와 Click 표시를 따라 진행하세요. 계정 정보는 가려져 있습니다. API 토큰의 권한(scope)은 csync에서 처리할 로컬 파일·폴더 작업 스코프와 별개의 설정입니다.</p>
<p><a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">Atlassian API 토큰 관리 열기 ↗</a></p>
<div class="token-guide-steps">${steps.map(([file, title, description], i) => `<details${i === 0 ? ' open' : ''}><summary>${i + 1}. ${title}</summary><p>${description}</p><figure><a href="/assets/guide/${file}.png" target="_blank" rel="noopener noreferrer" aria-label="${i + 1}단계 이미지 원본 크기로 보기"><img src="/assets/guide/${file}.png" alt="${title}: 빨간 테두리로 표시한 조작 위치" loading="lazy"></a><figcaption>이미지를 누르면 원본 크기로 볼 수 있습니다.</figcaption></figure></details>`).join('')}</div>
<h4>csync에서 사용하는 권한</h4>
<p>아래 이름 전체를 검색하세요. 조회·Pull에는 기본 읽기 권한을, Push에는 필요한 쓰기 권한을 추가합니다. 토큰 계정 자체에도 대상 스페이스의 해당 권한이 있어야 합니다.</p>
<div class="token-scope-table"><table><thead><tr><th>작업</th><th>권한</th></tr></thead><tbody>
<tr><td>스코프 탐색·문서 조회·Pull</td><td><code>read:space:confluence</code><br><code>read:page:confluence</code><br><code>read:content-details:confluence</code></td></tr>
<tr><td>페이지 Push</td><td><code>write:page:confluence</code></td></tr>
<tr><td>이미지·첨부 다운로드</td><td><code>read:attachment:confluence</code></td></tr>
<tr><td>이미지·첨부 업로드</td><td><code>read:content-details:confluence</code><br><code>write:attachment:confluence</code></td></tr>
<tr><td>README 없는 폴더 생성</td><td><code>write:folder:confluence</code></td></tr>
</tbody></table></div>
<h4>발급한 토큰 적용</h4><p>생성 직후 Copy to clipboard로 복사하여 <code>.env</code>의 <code>CONFLUENCE_API_TOKEN</code>에 넣습니다. 토큰은 발급 화면을 닫은 뒤 다시 확인할 수 없습니다. 웹의 <strong>.env 가져오기</strong>로 적용하거나 기준 폴더의 <code>.env</code>를 갱신한 뒤 <strong>설정 확인</strong>을 누르세요.</p>
<p>범위를 포함한 토큰의 <code>CONFLUENCE_BASE_URL</code>은 <code>https://api.atlassian.com/ex/confluence/&lt;CLOUD_ID&gt;/wiki</code> 형식입니다. Cloud ID는 <code>https://&lt;사이트&gt;.atlassian.net/_edge/tenant_info</code>의 <code>cloudId</code> 값입니다.</p>
<p><a href="https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/" target="_blank" rel="noopener noreferrer">Atlassian 공식 발급 안내 ↗</a> · <a href="https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content---children-and-descendants/" target="_blank" rel="noopener noreferrer">Confluence API 권한 문서 ↗</a></p>
</section>`;
