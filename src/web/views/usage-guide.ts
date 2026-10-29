const screens = [
  {file:'sync-workspace',title:'Fetch·Pull과 업로드할 문서 선택',width:1440,height:1280,
    description:'Fetch로 원격 신규·변경을 확인하고 받을 문서는 Pull로 가져옵니다. 보낼 문서만 체크한 뒤 업로드 미리보기를 실행해야 업로드 버튼이 활성화됩니다.'},
  {file:'remote-diff',title:'원격 본문과 로컬 문서 비교',width:1120,height:718,
    description:'문서 행의 diff 보기를 누르면 현재 원격 본문과 로컬 Markdown을 비교합니다. 왼쪽은 원격 HTML의 근사 변환본, 오른쪽은 로컬 본문입니다.'},
  {file:'document-preview',title:'문서 미리보기와 표 서식 정리',width:1078,height:867,
    description:'왼쪽에서 파일을 선택하고 문서 미리보기를 펼칩니다. 문서 서식 정리에서 기본 서식이나 모든 표의 내용에 맞춤·균등 배분을 적용하고, 변경 비교 후 저장합니다.'},
];

export const usageGuide = `<section id="help-screens"><h3>화면으로 보기</h3>
<p>문서와 Confluence 데이터는 사용법 설명용 예시입니다. 필요한 화면을 펼쳐 보세요.</p>
<div class="guide-steps usage-guide-steps">${screens.map(({file,title,description,width,height})=>`<details><summary>${title}</summary><p>${description}</p><figure><a href="/assets/guide/web/${file}.png" target="_blank" rel="noopener noreferrer" aria-label="${title} 화면 원본 크기로 보기"><img src="/assets/guide/web/${file}.png" alt="${title} 사용 화면" width="${width}" height="${height}" loading="lazy" decoding="async"></a><figcaption>이미지를 누르면 새 탭에서 원본 크기로 볼 수 있습니다.</figcaption></figure></details>`).join('')}</div>
</section>`;
