# 기여 안내

버그 수정이나 기능 변경을 제안하려면 재현 방법과 기대 동작을 이슈 또는 Pull Request에 설명해 주세요.

## 개발 환경

`npm test`로 전체 테스트, `npm run test:coverage`로 커버리지를 확인합니다. 테스트는 실제 Confluence에 접속하지 않습니다.

```bash
git clone https://github.com/wonseok-han/confluence-sync.git
cd confluence-sync
npm install
npm run build
```

소스에서 바로 실행할 때는 `npm run` 스크립트를 쓰고, 인자는 **`--` 뒤에** 둡니다.

| 글로벌 | 로컬 |
| --- | --- |
| `confluence-sync` | `npm run sync` |
| `confluence-sync --dry-run` | `npm run sync:dry` |
| `confluence-sync --list` | `npm run list -- --base ./docs` |

웹 화면을 소스에서 실행하려면 `npm run web`을 사용합니다. 변경한 기능에 맞는 테스트를 실행하고, Pull Request에 검증 결과를 함께 적어 주세요.

배포 권한을 가진 유지보수자는 [릴리스 절차](docs/RELEASING.md)를 참고하세요.
